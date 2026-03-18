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
from backend.config import settings
from backend.models import TranscriptSegment
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


async def correct_transcript(
    segments: list[TranscriptSegment],
    orchestrator: AIOrchestrator,
    batch_size: int = 30,
    job_id: str = "",
) -> list[TranscriptSegment]:
    """Correct transcript text using the configured LLM.

    Processes segments in batches to fit within context limits.
    Each batch retries up to MAX_BATCH_RETRIES times on parse/format
    failures before skipping, giving the provider chain a chance to
    fall back to alternative providers.
    Word timestamps are preserved — only the text field is modified.
    """
    if not settings.AI_TRANSCRIPT_CORRECTION:
        return segments

    if not segments:
        return segments

    corrected = list(segments)  # Copy to avoid mutating input
    total_batches = -(-len(segments) // batch_size)  # ceiling division

    for batch_idx, batch_start in enumerate(range(0, len(segments), batch_size)):
        batch = segments[batch_start : batch_start + batch_size]
        batch_label = f"batch {batch_idx + 1}/{total_batches} (segments {batch_start}-{batch_start + len(batch) - 1})"

        # Build the prompt with segment texts
        seg_texts = [{"index": i, "text": seg.text} for i, seg in enumerate(batch)]
        prompt = CORRECTION_PROMPT.format(
            segments_json=json.dumps(seg_texts, indent=2),
            count=len(batch),
        )

        batch_succeeded = False
        for attempt in range(MAX_BATCH_RETRIES + 1):
            try:
                response = await asyncio.wait_for(
                    orchestrator.text_completion(prompt, timeout=45, job_id=job_id),
                    timeout=60,  # Hard outer timeout per batch attempt
                )

                corrections = _parse_correction_response(response, len(batch))
                if corrections is None:
                    logger.warning(
                        "AI correction %s returned unparseable/wrong-length response (attempt %d/%d)",
                        batch_label, attempt + 1, MAX_BATCH_RETRIES + 1,
                    )
                    if attempt < MAX_BATCH_RETRIES:
                        continue  # Retry — may hit a different provider via circuit breaker
                    break  # Exhausted retries

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
                batch_succeeded = True
                break  # Success — move to next batch

            except asyncio.TimeoutError:
                logger.warning("AI transcript correction timed out for %s (attempt %d/%d)",
                               batch_label, attempt + 1, MAX_BATCH_RETRIES + 1)
                if attempt < MAX_BATCH_RETRIES:
                    continue  # Retry — provider chain will try next provider
            except Exception as e:
                logger.warning("AI transcript correction failed for %s (attempt %d/%d): %s",
                               batch_label, attempt + 1, MAX_BATCH_RETRIES + 1, e)
                if attempt < MAX_BATCH_RETRIES:
                    continue

        if not batch_succeeded:
            logger.warning("All attempts exhausted for %s — keeping raw transcript for these segments", batch_label)

    return corrected
