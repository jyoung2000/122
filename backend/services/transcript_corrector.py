"""AI-powered transcript post-correction.

Uses the configured LLM provider to fix common Whisper transcription issues:
- Proper noun capitalization (people, brands, places)
- Punctuation and sentence boundaries
- Filler word removal (um, uh, like, you know)
- Number formatting inconsistencies
"""

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


async def correct_transcript(
    segments: list[TranscriptSegment],
    orchestrator: AIOrchestrator,
    batch_size: int = 30,
) -> list[TranscriptSegment]:
    """Correct transcript text using the configured LLM.

    Processes segments in batches to fit within context limits.
    Word timestamps are preserved — only the text field is modified.
    """
    if not settings.AI_TRANSCRIPT_CORRECTION:
        return segments

    if not segments:
        return segments

    corrected = list(segments)  # Copy to avoid mutating input

    for batch_start in range(0, len(segments), batch_size):
        batch = segments[batch_start : batch_start + batch_size]

        # Build the prompt with segment texts
        seg_texts = [{"index": i, "text": seg.text} for i, seg in enumerate(batch)]
        prompt = CORRECTION_PROMPT.format(
            segments_json=json.dumps(seg_texts, indent=2),
            count=len(batch),
        )

        try:
            response = await orchestrator.text_completion(prompt)

            # Parse the JSON array response
            # Strip markdown code fences if present
            cleaned = response.strip()
            if cleaned.startswith("```"):
                cleaned = cleaned.split("\n", 1)[1] if "\n" in cleaned else cleaned[3:]
            if cleaned.endswith("```"):
                cleaned = cleaned[:-3]
            cleaned = cleaned.strip()

            corrections = json.loads(cleaned)

            if isinstance(corrections, list) and len(corrections) == len(batch):
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
            else:
                logger.warning(
                    "AI correction returned %d items for %d segments — skipping batch",
                    len(corrections) if isinstance(corrections, list) else -1,
                    len(batch),
                )
        except json.JSONDecodeError:
            logger.warning("AI correction returned non-JSON response — skipping batch")
        except Exception as e:
            logger.warning("AI transcript correction failed for batch: %s", e)

    return corrected
