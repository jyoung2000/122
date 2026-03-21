"""Subtitle translation service.

Translates TranscriptSegment[] from source language to target language
using the configured AI provider. Preserves timing, speaker labels, and
generates proportional word timestamps for translated text.

If the primary provider fails (e.g. vision-only model), falls back to
a dedicated Ollama translation model (OLLAMA_TRANSLATION_MODEL).
"""

import json
import logging
from typing import Optional

import httpx

from backend.config import settings
from backend.models import TranscriptSegment, WordTimestamp
from backend.services.ai_orchestrator import AIOrchestrator

logger = logging.getLogger(__name__)

SUPPORTED_LANGUAGES = {
    "en": "English", "es": "Spanish", "fr": "French", "de": "German",
    "it": "Italian", "pt": "Portuguese", "ru": "Russian", "ja": "Japanese",
    "ko": "Korean", "zh": "Chinese (Simplified)", "ar": "Arabic",
    "hi": "Hindi", "nl": "Dutch", "pl": "Polish", "tr": "Turkish",
    "vi": "Vietnamese", "th": "Thai", "uk": "Ukrainian", "sv": "Swedish",
    "id": "Indonesian", "ms": "Malay", "tl": "Filipino",
}

TRANSLATION_PROMPT = """Translate the following subtitle segments from {source_lang} to {target_lang}.

Rules:
1. Translate naturally — do NOT transliterate or leave words in the source language
2. Preserve the meaning, tone, and speaker intent
3. Keep translations concise — subtitles must be readable in 2-3 seconds
4. Preserve proper nouns (names of people, brands) unless they have standard translations
5. Return EXACTLY {count} translated strings as a JSON array
6. If a segment is very short (e.g., "Yeah", "Okay"), translate the equivalent expression

Segments to translate:
{segments_json}

Return ONLY a JSON array of {count} translated strings.
Example: ["Translated one.", "Translated two."]"""


def _generate_proportional_word_timestamps(
    text: str, start: float, end: float
) -> list[WordTimestamp]:
    """Generate proportional word timestamps for translated text.

    Since we don't have actual word-level alignment for translations,
    distribute the segment duration proportionally across words
    based on character count.
    """
    words = text.split()
    if not words:
        return []

    duration = end - start
    total_chars = sum(len(w) for w in words)
    if total_chars == 0:
        word_dur = duration / len(words)
        return [
            WordTimestamp(
                start=round(start + i * word_dur, 3),
                end=round(start + (i + 1) * word_dur, 3),
                word=w,
            )
            for i, w in enumerate(words)
        ]

    current = start
    result = []
    for w in words:
        char_ratio = len(w) / total_chars
        word_dur = duration * char_ratio
        result.append(WordTimestamp(
            start=round(current, 3),
            end=round(current + word_dur, 3),
            word=w,
        ))
        current += word_dur
    return result


def _parse_translation_response(response: str) -> list:
    """Parse a JSON array from an LLM translation response."""
    cleaned = response.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.split("\n", 1)[1] if "\n" in cleaned else cleaned[3:]
    if cleaned.endswith("```"):
        cleaned = cleaned[:-3]
    cleaned = cleaned.strip()
    return json.loads(cleaned)


async def _ensure_ollama_model(model: str) -> bool:
    """Check if the Ollama model exists locally; pull it if not."""
    host = settings.OLLAMA_HOST
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(10.0)) as client:
            resp = await client.post(f"{host}/api/show", json={"model": model})
            if resp.status_code == 200:
                return True
    except Exception:
        pass

    # Model not found — pull it
    logger.info("Translation model %s not found locally — pulling from Ollama registry...", model)
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(connect=10, read=1800, write=10, pool=10)) as client:
            resp = await client.post(
                f"{host}/api/pull",
                json={"name": model},
            )
            if resp.status_code == 200:
                logger.info("Successfully pulled translation model: %s", model)
                return True
            else:
                logger.warning("Failed to pull translation model %s: HTTP %d", model, resp.status_code)
                return False
    except Exception as e:
        logger.warning("Failed to pull translation model %s: %s", model, e)
        return False


async def _translate_batch_via_ollama(
    prompt: str,
    model: str,
    timeout: float = 180.0,
) -> str:
    """Call Ollama chat API directly with a dedicated translation model."""
    host = settings.OLLAMA_HOST
    async with httpx.AsyncClient(timeout=httpx.Timeout(timeout, connect=15.0)) as client:
        resp = await client.post(
            f"{host}/api/chat",
            json={
                "model": model,
                "messages": [{"role": "user", "content": prompt}],
                "stream": False,
                "options": {
                    "num_ctx": 4096,
                    "temperature": 0.3,
                    "num_predict": 4096,
                },
            },
        )
        resp.raise_for_status()
        data = resp.json()
        return data.get("message", {}).get("content", "")


def _apply_batch_translations(
    batch: list[TranscriptSegment],
    translations: list,
) -> list[TranscriptSegment]:
    """Convert raw translation strings + original segments into translated TranscriptSegments."""
    result = []
    for i, trans_text in enumerate(translations):
        orig = batch[i]
        if isinstance(trans_text, str) and trans_text.strip():
            trans_words = _generate_proportional_word_timestamps(
                trans_text.strip(), orig.start, orig.end
            )
            result.append(TranscriptSegment(
                start=orig.start,
                end=orig.end,
                text=trans_text.strip(),
                speaker=orig.speaker,
                words=trans_words,
                confidence=orig.confidence,
            ))
        else:
            result.append(orig)
    return result


async def translate_segments(
    segments: list[TranscriptSegment],
    source_language: str,
    target_language: str,
    orchestrator: AIOrchestrator,
    batch_size: int = 25,
    progress_callback=None,
) -> list[TranscriptSegment]:
    """Translate transcript segments to the target language.

    Returns new TranscriptSegment[] with translated text and
    proportional word timestamps. Original timing is preserved.
    """
    if source_language == target_language:
        return segments

    source_name = SUPPORTED_LANGUAGES.get(source_language, source_language)
    target_name = SUPPORTED_LANGUAGES.get(target_language, target_language)

    # If source is "auto" or unknown, try to detect from segment text
    if source_language in ("auto", "") and segments:
        source_name = "the original language"

    translated = []
    total_batches = (len(segments) + batch_size - 1) // batch_size
    consecutive_failures = 0
    MAX_CONSECUTIVE_BATCH_FAILURES = 3

    for batch_idx, batch_start in enumerate(range(0, len(segments), batch_size)):
        batch = segments[batch_start : batch_start + batch_size]

        seg_texts = [{"index": i, "text": seg.text} for i, seg in enumerate(batch)]
        prompt = TRANSLATION_PROMPT.format(
            source_lang=source_name,
            target_lang=target_name,
            count=len(batch),
            segments_json=json.dumps(seg_texts, ensure_ascii=False, indent=2),
        )

        batch_success = False
        for attempt in range(2):  # 2 attempts per batch
            try:
                response = await orchestrator.text_completion(prompt, timeout=120)
                translations = _parse_translation_response(response)

                if isinstance(translations, list) and len(translations) == len(batch):
                    translated.extend(_apply_batch_translations(batch, translations))
                    batch_success = True
                    break
                else:
                    logger.warning("Translation batch %d attempt %d: wrong count (got %d, expected %d)",
                                   batch_idx, attempt + 1,
                                   len(translations) if isinstance(translations, list) else -1,
                                   len(batch))
            except Exception as e:
                logger.warning("Translation batch %d attempt %d failed: %s",
                               batch_idx, attempt + 1, e)

        if not batch_success:
            translated.extend(batch)  # Keep originals for this batch
            consecutive_failures += 1
            if consecutive_failures >= MAX_CONSECUTIVE_BATCH_FAILURES:
                logger.error(
                    "Translation: %d consecutive batch failures — aborting remaining batches",
                    consecutive_failures,
                )
                remaining_start = batch_start + batch_size
                translated.extend(segments[remaining_start:])
                break
        else:
            consecutive_failures = 0

        if progress_callback:
            pct = int(((batch_idx + 1) / total_batches) * 100)
            await progress_callback(pct)

    logger.info(
        "Translated %d segments from %s to %s",
        len(translated), source_name, target_name,
    )
    return translated


async def translate_segments_with_fallback(
    segments: list[TranscriptSegment],
    source_language: str,
    target_language: str,
    orchestrator: AIOrchestrator,
    batch_size: int = 25,
    progress_callback=None,
) -> list[TranscriptSegment]:
    """Translate segments, falling back to a dedicated Ollama model if the
    primary provider can't translate (e.g. vision-only model).

    This is the main entry point called by the pipeline. It:
    1. Tries the orchestrator's provider chain first
    2. Checks if translation actually changed the text
    3. If not, retries with OLLAMA_TRANSLATION_MODEL directly
    """
    if source_language == target_language:
        return segments

    # --- Attempt 1: Quick probe with orchestrator (small sample first) ---
    # Don't waste time translating all 1441 segments if the model can't translate.
    # Try a 10-segment sample first; only proceed with full translation if it works.
    probe_size = min(10, len(segments))
    probe_sample = segments[:probe_size]
    probe_result = await translate_segments(
        probe_sample, source_language, target_language,
        orchestrator, batch_size=probe_size,
    )
    probe_changed = sum(1 for t, o in zip(probe_result, probe_sample) if t.text != o.text)

    if probe_changed > 0:
        logger.info("Orchestrator probe: %d/%d segments changed — proceeding with full translation",
                     probe_changed, probe_size)
        result = await translate_segments(
            segments, source_language, target_language,
            orchestrator, batch_size, progress_callback,
        )
        changed = sum(1 for t, o in zip(result, segments) if t.text != o.text)
        if changed > 0:
            logger.info("Translation via orchestrator succeeded: %d/%d segments changed", changed, len(segments))
            return result
    else:
        logger.info("Orchestrator probe: 0/%d segments changed — skipping full orchestrator attempt",
                     probe_size)

    # --- Attempt 2: Direct Ollama with dedicated translation model ---
    translation_model = settings.OLLAMA_TRANSLATION_MODEL
    if not translation_model:
        raise RuntimeError("Translation produced no changes and no OLLAMA_TRANSLATION_MODEL configured")

    logger.warning(
        "Primary translation produced no changes (model may not support translation). "
        "Falling back to dedicated Ollama translation model: %s",
        translation_model,
    )

    # Ensure the translation model is available (pull if needed)
    model_ready = await _ensure_ollama_model(translation_model)
    if not model_ready:
        raise RuntimeError(f"Translation fallback model {translation_model} is not available and could not be pulled")

    source_name = SUPPORTED_LANGUAGES.get(source_language, source_language)
    target_name = SUPPORTED_LANGUAGES.get(target_language, target_language)
    if source_language in ("auto", "") and segments:
        source_name = "the original language"

    # Use smaller batches for the fallback model — small models handle
    # fewer segments more reliably, especially for CJK→English translation
    fallback_batch_size = 10
    translated = []
    total_batches = (len(segments) + fallback_batch_size - 1) // fallback_batch_size
    consecutive_failures = 0
    MAX_CONSECUTIVE_BATCH_FAILURES = 5  # more tolerance — don't abort early

    for batch_idx, batch_start in enumerate(range(0, len(segments), fallback_batch_size)):
        batch = segments[batch_start : batch_start + fallback_batch_size]

        seg_texts = [{"index": i, "text": seg.text} for i, seg in enumerate(batch)]
        prompt = TRANSLATION_PROMPT.format(
            source_lang=source_name,
            target_lang=target_name,
            count=len(batch),
            segments_json=json.dumps(seg_texts, ensure_ascii=False, indent=2),
        )

        batch_success = False
        for attempt in range(3):  # 3 attempts per batch for fallback
            try:
                response = await _translate_batch_via_ollama(prompt, translation_model, timeout=180.0)
                translations = _parse_translation_response(response)

                if isinstance(translations, list) and len(translations) == len(batch):
                    translated.extend(_apply_batch_translations(batch, translations))
                    batch_success = True
                    break
                else:
                    logger.warning("Ollama fallback batch %d attempt %d: wrong count (got %d, expected %d)",
                                   batch_idx, attempt + 1,
                                   len(translations) if isinstance(translations, list) else -1,
                                   len(batch))
            except Exception as e:
                logger.warning("Ollama fallback batch %d attempt %d failed: %s",
                               batch_idx, attempt + 1, e)

        if not batch_success:
            translated.extend(batch)
            consecutive_failures += 1
            if consecutive_failures >= MAX_CONSECUTIVE_BATCH_FAILURES:
                logger.error(
                    "Ollama fallback translation: %d consecutive batch failures — aborting",
                    consecutive_failures,
                )
                remaining_start = batch_start + fallback_batch_size
                translated.extend(segments[remaining_start:])
                break
        else:
            consecutive_failures = 0

        if progress_callback:
            pct = int(((batch_idx + 1) / total_batches) * 100)
            await progress_callback(pct)

    # Verify the fallback actually translated something
    changed = sum(1 for t, o in zip(translated, segments) if t.text != o.text)
    if changed == 0:
        raise RuntimeError(
            f"Fallback model {translation_model} also produced no changes — "
            "try a more capable model (e.g. qwen2.5:7b or llama3.1:8b-instruct-q4_0)"
        )

    logger.info(
        "Translated %d/%d segments via Ollama fallback model %s",
        changed, len(translated), translation_model,
    )
    return translated
