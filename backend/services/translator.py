"""Subtitle translation service.

Translates TranscriptSegment[] from source language to target language
using the configured AI provider. Preserves timing, speaker labels, and
generates proportional word timestamps for translated text.
"""

import json
import logging
from typing import Optional

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
        # Use the target language name directly; the LLM can figure it out
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

                # Parse JSON response
                cleaned = response.strip()
                if cleaned.startswith("```"):
                    cleaned = cleaned.split("\n", 1)[1] if "\n" in cleaned else cleaned[3:]
                if cleaned.endswith("```"):
                    cleaned = cleaned[:-3]
                cleaned = cleaned.strip()

                translations = json.loads(cleaned)

                if isinstance(translations, list) and len(translations) == len(batch):
                    for i, trans_text in enumerate(translations):
                        orig = batch[i]
                        if isinstance(trans_text, str) and trans_text.strip():
                            trans_words = _generate_proportional_word_timestamps(
                                trans_text.strip(), orig.start, orig.end
                            )
                            translated.append(TranscriptSegment(
                                start=orig.start,
                                end=orig.end,
                                text=trans_text.strip(),
                                speaker=orig.speaker,
                                words=trans_words,
                                confidence=orig.confidence,
                            ))
                        else:
                            translated.append(orig)
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
                # Keep originals for all remaining batches
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
