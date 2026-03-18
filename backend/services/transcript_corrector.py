"""AI-powered transcript post-correction.

Uses the configured LLM provider to fix common Whisper transcription issues:
- Proper noun capitalization (people, brands, places)
- Punctuation and sentence boundaries
- Filler word removal (um, uh, like, you know)
- Number formatting inconsistencies
"""

import asyncio
import json
import logging
from difflib import SequenceMatcher
from backend.config import settings
from backend.models import TranscriptSegment, WordTimestamp
from backend.services.ai_orchestrator import AIOrchestrator

logger = logging.getLogger(__name__)

CORRECTION_PROMPT = """You are a transcript correction assistant. Fix the following transcript segments while preserving their exact timing and structure.

Rules:
1. Fix capitalization of proper nouns (names, brands, places)
2. Fix punctuation and sentence boundaries
3. Remove filler words: "um", "uh", "like" (when used as filler), "you know", "I mean" (when used as filler)
4. Fix obvious transcription errors (e.g., "there" → "their" based on context)
5. DO NOT change the meaning, add content, or rephrase
6. DO NOT merge or split segments — return exactly the same number of segments
7. Return ONLY a JSON array of corrected text strings, one per input segment

Input segments:
{segments_json}

Return a JSON array of corrected text strings, exactly {count} elements.
Example: ["Fixed text one.", "Fixed text two."]"""


MAX_BATCH_RETRIES = 2  # Retry each batch up to 2 times on parse failures


def _realign_word_timestamps(segment: TranscriptSegment, original_text: str) -> TranscriptSegment:
    """Re-align word timestamps after AI text correction.

    When the AI removes filler words or changes text, the word-level
    timestamps may no longer match. This function attempts to preserve
    timestamps for words that survived the correction.
    """
    if not segment.words:
        return segment

    corrected_words = segment.text.split()
    original_words = [w.word for w in segment.words]

    if not corrected_words:
        return segment

    # Build a mapping from corrected words to original word timestamps
    # using a greedy alignment via SequenceMatcher
    matcher = SequenceMatcher(
        None,
        [w.lower().strip('.,!?;:') for w in original_words],
        [w.lower().strip('.,!?;:') for w in corrected_words],
    )

    new_word_timestamps = []
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == 'equal':
            for orig_idx, corr_idx in zip(range(i1, i2), range(j1, j2)):
                orig_wt = segment.words[orig_idx]
                new_word_timestamps.append(WordTimestamp(
                    start=orig_wt.start,
                    end=orig_wt.end,
                    word=corrected_words[corr_idx],
                ))
        elif tag == 'replace':
            # Map replacement words to the original time span
            if i1 < len(segment.words) and i2 <= len(segment.words):
                span_start = segment.words[i1].start
                span_end = segment.words[i2 - 1].end
                corr_count = j2 - j1
                if corr_count > 0:
                    span_duration = span_end - span_start
                    per_word = span_duration / corr_count
                    for k, corr_idx in enumerate(range(j1, j2)):
                        new_word_timestamps.append(WordTimestamp(
                            start=round(span_start + k * per_word, 3),
                            end=round(span_start + (k + 1) * per_word, 3),
                            word=corrected_words[corr_idx],
                        ))
        elif tag == 'insert':
            # New words inserted by AI — interpolate timestamps
            if new_word_timestamps:
                last_end = new_word_timestamps[-1].end
                next_start = segment.words[i1].start if i1 < len(segment.words) else last_end + 0.1
                gap = next_start - last_end
                corr_count = j2 - j1
                per_word = gap / max(corr_count, 1)
                for k, corr_idx in enumerate(range(j1, j2)):
                    new_word_timestamps.append(WordTimestamp(
                        start=round(last_end + k * per_word, 3),
                        end=round(last_end + (k + 1) * per_word, 3),
                        word=corrected_words[corr_idx],
                    ))
        # tag == 'delete' — filler words removed, skip their timestamps

    if new_word_timestamps:
        return segment.model_copy(update={"words": new_word_timestamps})
    return segment


def _parse_correction_response(response: str, expected_count: int) -> list[str] | None:
    """Parse an AI correction response into a list of strings.

    Returns the list on success, or None if the response is unparseable or
    has the wrong number of elements.
    """
    cleaned = response.strip()
    # Strip markdown code fences if present
    if cleaned.startswith("```"):
        cleaned = cleaned.split("\n", 1)[1] if "\n" in cleaned else cleaned[3:]
    if cleaned.endswith("```"):
        cleaned = cleaned[:-3]
    cleaned = cleaned.strip()

    try:
        corrections = json.loads(cleaned)
    except json.JSONDecodeError:
        return None

    if isinstance(corrections, list) and len(corrections) == expected_count:
        return corrections
    return None


# Timeouts — standard models finish in 5-30s; thinking models need 60-120s+
_THINKING_MODEL_TIMEOUT = 120     # inner timeout per attempt for thinking models
_STANDARD_MODEL_TIMEOUT = 60      # inner timeout per attempt for standard models
_OUTER_TIMEOUT_MARGIN = 30        # outer timeout = inner + this margin


async def correct_transcript(
    segments: list[TranscriptSegment],
    orchestrator: AIOrchestrator,
    batch_size: int = 30,
    job_id: str = "",
) -> list[TranscriptSegment]:
    """Correct transcript text using the user's configured AI text model.

    The model used is determined by the active provider chain — for OpenRouter,
    this is settings.OPENROUTER_TEXT_MODEL (selected by the user in Settings).

    Uses skip_circuit_breaker=True so failures here do NOT degrade providers
    for subsequent critical operations (summary, clip detection).
    Implements early exit: if the first batch fails, remaining batches are
    skipped (the provider/model is likely to fail for all of them too).
    Word timestamps are re-aligned after text changes.
    """
    if not settings.AI_TRANSCRIPT_CORRECTION:
        return segments

    if not segments:
        return segments

    # Query which model will handle polishing so we can set an appropriate timeout
    model_info = orchestrator.get_text_model_info()
    model_name = model_info["model"]
    is_thinking = model_info["is_thinking"]

    if model_info["provider"] == "none":
        logger.warning("No AI providers available for transcript correction — skipping")
        return segments

    # Set timeout based on model type
    if is_thinking:
        inner_timeout = _THINKING_MODEL_TIMEOUT
        logger.info(
            "Transcript correction using thinking model %s via %s — timeout %ds per batch",
            model_name, model_info["provider"], inner_timeout,
        )
    else:
        inner_timeout = _STANDARD_MODEL_TIMEOUT
        logger.info(
            "Transcript correction using model %s via %s — timeout %ds per batch",
            model_name, model_info["provider"], inner_timeout,
        )
    outer_timeout = inner_timeout + _OUTER_TIMEOUT_MARGIN

    corrected = list(segments)  # Copy to avoid mutating input
    total_batches = -(-len(segments) // batch_size)  # ceiling division
    first_batch_failed = False

    for batch_idx, batch_start in enumerate(range(0, len(segments), batch_size)):
        batch = segments[batch_start : batch_start + batch_size]
        batch_label = f"batch {batch_idx + 1}/{total_batches} (segments {batch_start}-{batch_start + len(batch) - 1})"

        # Early exit: if the first batch failed, all subsequent batches
        # will fail too (same provider, same timeout, same model).
        if first_batch_failed:
            logger.info("Skipping %s — first batch failed, provider likely unavailable", batch_label)
            continue

        # Build the prompt with segment texts
        seg_texts = [{"index": i, "text": seg.text} for i, seg in enumerate(batch)]
        prompt = CORRECTION_PROMPT.format(
            segments_json=json.dumps(seg_texts, indent=2),
            count=len(batch),
        )

        batch_succeeded = False
        # Only 1 retry (2 total attempts). Correction is optional —
        # don't waste time on retries that will likely all timeout.
        max_attempts = min(MAX_BATCH_RETRIES + 1, 2)
        for attempt in range(max_attempts):
            try:
                response = await asyncio.wait_for(
                    orchestrator.text_completion(
                        prompt, timeout=inner_timeout, job_id=job_id,
                        skip_circuit_breaker=True,  # CRITICAL: don't poison the breaker
                    ),
                    timeout=outer_timeout,  # Hard outer timeout per batch attempt
                )

                corrections = _parse_correction_response(response, len(batch))
                if corrections is None:
                    logger.warning(
                        "AI correction %s returned unparseable/wrong-length response from %s (attempt %d/%d)",
                        batch_label, model_name, attempt + 1, max_attempts,
                    )
                    if attempt < max_attempts - 1:
                        continue
                    break

                # Apply corrections
                for i, new_text in enumerate(corrections):
                    if isinstance(new_text, str) and new_text.strip():
                        idx = batch_start + i
                        old_text = corrected[idx].text
                        corrected[idx] = corrected[idx].model_copy(
                            update={"text": new_text.strip()}
                        )
                        if old_text != new_text.strip():
                            logger.debug(
                                "Corrected [%.1fs]: '%s' → '%s'",
                                corrected[idx].start, old_text[:60], new_text.strip()[:60],
                            )
                            # Re-align word timestamps after text correction
                            if corrected[idx].words:
                                corrected[idx] = _realign_word_timestamps(corrected[idx], old_text)
                batch_succeeded = True
                break  # Success — move to next batch

            except asyncio.TimeoutError:
                logger.warning("AI transcript correction timed out for %s using %s (attempt %d/%d, %ds timeout)",
                               batch_label, model_name, attempt + 1, max_attempts, inner_timeout)
                if attempt < max_attempts - 1:
                    continue
            except Exception as e:
                logger.warning("AI transcript correction failed for %s using %s (attempt %d/%d): %s",
                               batch_label, model_name, attempt + 1, max_attempts, e)
                if attempt < max_attempts - 1:
                    continue

        if not batch_succeeded:
            logger.warning("All attempts exhausted for %s via %s — keeping raw transcript for these segments",
                           batch_label, model_name)
            if batch_idx == 0:
                first_batch_failed = True
                logger.warning("First batch failed — will skip remaining %d batches (model %s likely unavailable or too slow)",
                               total_batches - 1, model_name)

    return corrected
