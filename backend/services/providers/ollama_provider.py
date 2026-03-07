import base64
import json
import logging
from typing import Optional

import httpx

from backend.config import settings
from backend.models import (
    FrameData, SceneDescription, TranscriptSegment, VideoSummary, ClipCandidate, ClipSEO,
)
from backend.services.providers.base import AIProvider, ProviderError, extract_json, extract_description_fallback, normalize_seo_data, build_fallback_summary
from backend.services.prompts import DEFAULT_FRAME_ANALYSIS_PROMPT, DEFAULT_VIRAL_CLIP_PROMPT, DEFAULT_SEO_PROMPT, DEFAULT_SUMMARY_PROMPT

# JSON schema appended to vision prompts so Ollama returns structured data
# including subject_x for dynamic subject tracking.
_VISION_JSON_SUFFIX = (
    '\n\nReturn ONLY valid JSON:\n'
    '{"timestamp": <float>, "description": "<text>", '
    '"importance_score": <1-10>, "subject_x": <0-100>}\n'
    'subject_x = horizontal center of the main subject\'s FACE as % of frame width '
    '(0=far left, 50=exact center, 100=far right). '
    'IMPORTANT: Carefully estimate the actual position — do NOT default to 50 for every frame.'
)

logger = logging.getLogger(__name__)


class OllamaProvider(AIProvider):
    """Local Ollama provider - always available as final fallback."""

    def __init__(self):
        self._host = settings.OLLAMA_HOST
        self._vision_model = settings.OLLAMA_VISION_MODEL
        self._text_model = settings.OLLAMA_TEXT_MODEL
        self._summary_model = self._text_model
        self._total_tokens = 0

    @property
    def supports_vision(self) -> bool:
        return True

    @property
    def provider_name(self) -> str:
        return "ollama"

    async def _call_vision(self, prompt: str, image_base64: str) -> str:
        """Send ONE frame at a time to the vision model - VRAM constraint."""
        async with httpx.AsyncClient(timeout=120.0) as client:
            try:
                response = await client.post(
                    f"{self._host}/api/generate",
                    json={
                        "model": self._vision_model,
                        "prompt": prompt,
                        "images": [image_base64],
                        "stream": False,
                    },
                )
                response.raise_for_status()
                data = response.json()
                self._total_tokens += data.get("prompt_eval_count", 0) + data.get("eval_count", 0)
                return data.get("response", "")
            except Exception as e:
                raise ProviderError(f"Ollama vision error: {e}")

    async def _call_text(self, prompt: str, system: str = "", max_tokens: int = 4096, timeout: float = 90.0) -> str:
        async with httpx.AsyncClient(timeout=timeout) as client:
            try:
                payload = {
                    "model": self._text_model,
                    "prompt": prompt,
                    "stream": False,
                    "options": {"num_predict": max_tokens},
                }
                if system:
                    payload["system"] = system
                logger.debug("Ollama _call_text: model=%s, prompt_len=%d, system_len=%d, timeout=%.0fs",
                             self._text_model, len(prompt), len(system), timeout)
                response = await client.post(
                    f"{self._host}/api/generate",
                    json=payload,
                )
                response.raise_for_status()
                data = response.json()
                self._total_tokens += data.get("prompt_eval_count", 0) + data.get("eval_count", 0)
                result = data.get("response", "")
                if not result:
                    logger.warning("Ollama returned empty response for model=%s", self._text_model)
                return result
            except httpx.TimeoutException:
                raise ProviderError(f"Ollama text timeout after {timeout}s (model={self._text_model})")
            except httpx.HTTPStatusError as e:
                raise ProviderError(f"Ollama HTTP {e.response.status_code}: {e.response.text[:200]}")
            except Exception as e:
                raise ProviderError(f"Ollama text error ({type(e).__name__}): {e}")

    async def analyze_frames(
        self, frames: list[FrameData], custom_prompt: Optional[str] = None,
        cancel_check=None, progress_callback=None,
    ) -> list[SceneDescription]:
        instruction = custom_prompt if custom_prompt else DEFAULT_FRAME_ANALYSIS_PROMPT
        scenes = []
        total = len(frames)
        # Process ONE frame at a time (VRAM constraint)
        for fi, frame in enumerate(frames):
            if cancel_check:
                cancel_check()
            if not frame.base64:
                continue
            prompt = instruction + _VISION_JSON_SUFFIX
            try:
                raw = await self._call_vision(prompt, frame.base64)
                # Try JSON parsing first (preferred — extracts subject_x)
                importance = 5
                subject_x = 50
                description = raw.strip()
                try:
                    text = raw.strip()
                    # Strip markdown code fences
                    if text.startswith("```"):
                        text = text.split("\n", 1)[1].rsplit("```", 1)[0].strip()
                    # Find JSON in response
                    json_start = text.find("{")
                    json_end = text.rfind("}") + 1
                    if json_start >= 0 and json_end > json_start:
                        parsed = json.loads(text[json_start:json_end])
                        if isinstance(parsed, list) and parsed:
                            parsed = parsed[0]
                        description = parsed.get("description", description)
                        importance = max(1, min(10, int(parsed.get("importance_score", 5))))
                        raw_sx = parsed.get("subject_x")
                        if raw_sx is None:
                            logger.warning("Ollama frame %d: missing subject_x field", fi)
                        subject_x = max(0, min(100, int(raw_sx))) if raw_sx is not None else 50
                    else:
                        raise json.JSONDecodeError("No JSON object found", text, 0)
                except (json.JSONDecodeError, KeyError, TypeError, ValueError):
                    # Fall back to word-scanning for importance score
                    for word in raw.split():
                        try:
                            val = int(word.strip(".,/()"))
                            if 1 <= val <= 10:
                                importance = val
                                break
                        except ValueError:
                            continue
                scenes.append(SceneDescription(
                    timestamp=frame.timestamp,
                    description=description,
                    importance_score=importance,
                    thumbnail_path=frame.path,
                    subject_x=subject_x,
                ))
            except Exception as e:
                logger.warning(f"Ollama frame analysis failed for {frame.timestamp}s: {e}")
                scenes.append(SceneDescription(
                    timestamp=frame.timestamp,
                    description="Analysis failed (local AI)",
                    importance_score=5,
                    thumbnail_path=frame.path,
                    subject_x=50,
                ))
            if progress_callback:
                await progress_callback(fi + 1, total)
        return scenes

    async def generate_summary(
        self,
        transcript: list[TranscriptSegment],
        scenes: list[SceneDescription],
        cancel_check=None,
        custom_prompt=None,
    ) -> VideoSummary:
        instruction = custom_prompt if custom_prompt else DEFAULT_SUMMARY_PROMPT
        transcript_text = "\n".join(
            f"[{s.start:.1f}-{s.end:.1f}] {s.speaker}: {s.text}" for s in transcript
        )
        scene_text = "\n".join(
            f"[{s.timestamp:.1f}s] {s.description}" for s in scenes
        ) if scenes else "No scene descriptions available."

        prompt = (
            f"{instruction}\n\n"
            f"TRANSCRIPT:\n{transcript_text[:3000]}\n\n"
            f"SCENES:\n{scene_text[:1000]}\n\n"
            "Return ONLY valid JSON:\n"
            '{"overview": "<paragraph>", "key_topics": ["topic1", "topic2"], '
            '"tone": "<tone>", "estimated_audience": "<audience>", "content_category": "<category>"}'
        )
        raw = await self._call_text(prompt)
        try:
            data = extract_json(raw)
            return VideoSummary(**data)
        except Exception:
            logger.warning("Failed to parse summary JSON, using fallback extraction. Raw (first 300): %s", raw[:300])
            return VideoSummary(**build_fallback_summary(raw))

    async def detect_viral_clips(
        self,
        transcript: list[TranscriptSegment],
        scenes: list[SceneDescription],
        video_duration: float,
        custom_prompt: Optional[str] = None,
        cancel_check=None,
        clip_count: Optional[int] = None,
        min_duration: Optional[float] = None,
        max_duration: Optional[float] = None,
        video_summary: Optional[str] = None,
        existing_clips: Optional[str] = None,
    ) -> list[ClipCandidate]:
        instruction = custom_prompt if custom_prompt else DEFAULT_VIRAL_CLIP_PROMPT

        # Merge consecutive segments from the same speaker for compactness
        merged_transcript: list[tuple[float, float, str, str]] = []
        for seg in transcript:
            if merged_transcript and merged_transcript[-1][3] == seg.speaker:
                prev = merged_transcript[-1]
                merged_transcript[-1] = (prev[0], seg.end, prev[2] + " " + seg.text, seg.speaker)
            else:
                merged_transcript.append((seg.start, seg.end, seg.text, seg.speaker))

        transcript_text = "\n".join(
            f"[{s[0]:.0f}-{s[1]:.0f}] {s[3]}: {s[2]}" for s in merged_transcript
        )[:4000]

        scene_text = "\n".join(
            f"[{s.timestamp:.0f}s] {s.description[:80]}" for s in scenes
        )[:1500] if scenes else ""

        dur_min = int(min_duration) if min_duration else 30
        dur_max = int(max_duration) if max_duration else 300
        num_clips = clip_count or settings.MAX_CLIP_CANDIDATES

        system = (
            instruction + "\n"
            f"Each clip MUST be {dur_min}-{dur_max} seconds long.\n"
            "The main subject/speaker MUST stay in focus for the entire clip.\n"
            "Do NOT combine different scenes or unrelated topics into one clip.\n"
            "Return ONLY valid JSON."
        )
        # Ollama models have small context — keep summary brief
        summary_section = ""
        if video_summary:
            vs = video_summary[:500] if len(video_summary) > 500 else video_summary
            summary_section = f"VIDEO SUMMARY:\n{vs}\n\n"
        prompt = (
            f"Video duration: {video_duration:.1f}s\n\n"
            f"{summary_section}"
            f"TRANSCRIPT:\n{transcript_text}\n\n"
            f"SCENES:\n{scene_text}\n\n"
            f"You MUST return exactly {num_clips} viral clip candidates, ranked by viral potential from highest to lowest. "
            f"Do NOT return fewer than {num_clips} clips — find {num_clips} distinct moments even if some score lower. "
            f"Each clip must be between {dur_min} and {dur_max} seconds long.\n\n"
            'Return JSON: {"clips": [{"id": 1, "title": "...", "start_time": 0.0, '
            '"end_time": 60.0, "duration": 60.0, "viral_score": 50, '
            '"viral_score_reasoning": "...", "clip_type": "highlight", '
            '"platform": "both", "suggested_caption": "...", '
            '"hook_text": "...", "why_this_works": "..."}]}'
        )

        logger.info("Ollama clip detection prompt: system=%d chars, prompt=%d chars", len(system), len(prompt))

        for attempt in range(3):
            if cancel_check:
                cancel_check()
            # Use longer timeout for clip detection — local models are slow
            raw = await self._call_text(prompt, system=system, max_tokens=4096, timeout=110.0)
            if not raw or not raw.strip():
                logger.warning("Attempt %d: Ollama returned empty response for clip detection", attempt + 1)
                continue
            try:
                raw = raw.strip()
                if raw.startswith("```"):
                    raw = raw.split("\n", 1)[1].rsplit("```", 1)[0]
                start = raw.find("{")
                end = raw.rfind("}") + 1
                if start >= 0 and end > start:
                    data = json.loads(raw[start:end])
                else:
                    logger.warning("Attempt %d: Ollama response has no JSON object. Raw: %s", attempt + 1, raw[:300])
                    continue
                clips = []
                for c in data.get("clips", []):
                    st = float(c.get("start_time", 0))
                    et = float(c.get("end_time", 0))
                    duration = et - st if et > st else float(c.get("duration", 0))
                    if duration < 15 or duration > 600:
                        continue
                    clips.append(ClipCandidate(
                        id=c.get("id", len(clips) + 1),
                        title=c.get("title", "Untitled"),
                        start_time=st,
                        end_time=et,
                        duration=round(duration, 1),
                        viral_score=max(1, min(100, int(float(c.get("viral_score", 50))))),
                        viral_score_reasoning=str(c.get("viral_score_reasoning", "")),
                        clip_type=str(c.get("clip_type", "highlight")),
                        platform=str(c.get("platform", "both")),
                        suggested_caption=str(c.get("suggested_caption", "")),
                        hook_text=str(c.get("hook_text", "")),
                        why_this_works=str(c.get("why_this_works", "")),
                    ))
                if clips:
                    logger.info("Ollama parsed %d valid clips on attempt %d", len(clips), attempt + 1)
                    return clips
                logger.warning("Attempt %d: Ollama returned clips but all filtered out", attempt + 1)
            except (json.JSONDecodeError, KeyError) as e:
                logger.warning(f"Attempt {attempt + 1}: Ollama clips parse failed: {e}")
                continue
        raise ProviderError("Ollama: failed to parse viral clips after 3 attempts")

    async def generate_seo(
        self, clip_title: str, clip_transcript: str, video_summary: str,
        platform: str, cancel_check=None,
    ) -> ClipSEO:
        is_description = video_summary.startswith("DESCRIPTION_OVERRIDE")
        if is_description:
            prompt = (
                f"{video_summary[:3000]}\n\n"
                f"CLIP TITLE: {clip_title}\n"
                f"TARGET PLATFORM: {platform}\n\n"
                f"CLIP TRANSCRIPT:\n{clip_transcript[:2000]}\n"
            )
        else:
            prompt = (
                f"{DEFAULT_SEO_PROMPT}\n\n"
                f"CLIP TITLE: {clip_title}\n"
                f"TARGET PLATFORM: {platform}\n\n"
                f"VIDEO SUMMARY:\n{video_summary[:1000]}\n\n"
                f"CLIP TRANSCRIPT:\n{clip_transcript[:2000]}\n"
            )
        tokens = 16384 if is_description else 4096
        raw = await self._call_text(prompt, max_tokens=tokens)
        try:
            data = normalize_seo_data(extract_json(raw))
            return ClipSEO(**data)
        except Exception:
            logger.warning(f"Failed to parse SEO JSON, using fallback. Raw (first 300): {raw[:300]}")
            desc = extract_description_fallback(raw) if is_description and raw else (raw[:300] if raw else "SEO generation failed (local AI)")
            return ClipSEO(title=clip_title, description=desc, tags=[], platform_tips="")
