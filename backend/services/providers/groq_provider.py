import asyncio
import json
import logging
import time
from typing import Optional

from groq import AsyncGroq

from backend.config import settings
from backend.models import (
    FrameData, SceneDescription, TranscriptSegment, VideoSummary, ClipCandidate, ClipSEO,
)
from backend.services.providers.base import AIProvider, ProviderError, ProviderRateLimitError, extract_json, extract_description_fallback, normalize_seo_data, build_fallback_summary
from backend.services.prompts import DEFAULT_VIRAL_CLIP_PROMPT, DEFAULT_SEO_PROMPT, DEFAULT_SUMMARY_PROMPT

logger = logging.getLogger(__name__)

MODEL = "llama-3.3-70b-versatile"

_API_TIMEOUT = 90  # 90s — Groq is fast


class GroqProvider(AIProvider):
    """Groq provider - text only, no vision support."""

    def __init__(self):
        self._client = AsyncGroq(api_key=settings.GROQ_API_KEY)
        self._total_tokens = 0

    @property
    def supports_vision(self) -> bool:
        return False

    @property
    def provider_name(self) -> str:
        return "groq"

    async def _call(self, messages: list[dict], max_tokens: int = 4096) -> str:
        t0 = time.monotonic()
        try:
            response = await asyncio.wait_for(
                self._client.chat.completions.create(
                    model=MODEL,
                    messages=messages,
                    max_tokens=max_tokens,
                    temperature=0.3,
                ),
                timeout=_API_TIMEOUT,
            )
            elapsed = time.monotonic() - t0
            logger.info("Groq call completed in %.1fs", elapsed)
            if response.usage:
                self._total_tokens += response.usage.total_tokens
            if not response.choices:
                raise ProviderError("Groq empty response: no choices returned")
            return response.choices[0].message.content or ""
        except asyncio.TimeoutError:
            logger.error("Groq call timed out after %ds", _API_TIMEOUT)
            raise ProviderError(f"Groq timeout: no response in {_API_TIMEOUT}s")
        except Exception as e:
            err_str = str(e).lower()
            if "429" in str(e) or "rate" in err_str:
                raise ProviderRateLimitError(f"Groq rate limited: {e}")
            raise ProviderError(f"Groq error: {e}")

    async def analyze_frames(
        self, frames: list[FrameData], custom_prompt: Optional[str] = None,
        cancel_check=None, progress_callback=None,
    ) -> list[SceneDescription]:
        # Groq has no vision capability
        return []

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
            f"[{s.timestamp:.1f}s] (importance: {s.importance_score}/10) {s.description}"
            for s in scenes
        ) if scenes else "No scene descriptions available."
        prompt = (
            f"{instruction}\n\n"
            f"TRANSCRIPT:\n{transcript_text}\n\n"
            f"SCENES:\n{scene_text}\n\n"
            "Return ONLY valid JSON:\n"
            '{"overview": "<paragraph>", "key_topics": ["<topic1>", ...], '
            '"tone": "<tone>", "estimated_audience": "<audience>", "content_category": "<category>"}'
        )
        messages = [{"role": "user", "content": prompt}]
        raw = await self._call(messages)
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
        # Groq models have limited context — keep data compact
        max_transcript = 8000
        max_scenes = 3000
        transcript_text = "\n".join(
            f"[{s.start:.1f}-{s.end:.1f}] {s.speaker}: {s.text}" for s in transcript
        )
        if len(transcript_text) > max_transcript:
            transcript_text = transcript_text[:max_transcript] + f"\n... (truncated, {len(transcript)} total segments)"
        scene_text = "\n".join(
            f"[{s.timestamp:.1f}s] (importance: {s.importance_score}/10) {s.description}"
            for s in scenes
        ) if scenes else "No scene descriptions available."
        if len(scene_text) > max_scenes:
            scene_text = scene_text[:max_scenes] + f"\n... (truncated, {len(scenes)} total scenes)"
        dur_min = int(min_duration) if min_duration else 30
        dur_max = int(max_duration) if max_duration else 300
        num_clips = clip_count or settings.MAX_CLIP_CANDIDATES
        system_prompt = (
            instruction + "\n\n"
            "STRICT REQUIREMENTS:\n"
            f"- Each clip duration MUST be between {dur_min} and {dur_max} seconds\n"
            "- Natural start/end points\n"
            "- Must work standalone\n"
            "- The main subject/speaker MUST remain in focus for the entire clip\n"
            "- Do NOT combine scenes from different settings or unrelated topics\n\n"
            "Return ONLY valid JSON:\n"
            '{"clips": [{"id": 1, "title": "...", "start_time": 0.0, "end_time": 0.0, '
            '"duration": 0.0, "viral_score": 50, "viral_score_reasoning": "...", '
            '"clip_type": "highlight", "platform": "both", "suggested_caption": "...", '
            '"hook_text": "...", "why_this_works": "..."}]}'
        )
        summary_section = ""
        if video_summary:
            summary_section = f"VIDEO SUMMARY:\n{video_summary}\n\n"
        user_prompt = (
            f"Video duration: {video_duration:.1f}s\n\n"
            f"{summary_section}"
            f"TRANSCRIPT:\n{transcript_text}\n\n"
            f"SCENES:\n{scene_text}\n\n"
            f"You MUST return exactly {num_clips} viral clip candidates, ranked by viral potential from highest to lowest. "
            f"Do NOT return fewer than {num_clips} clips — find {num_clips} distinct moments even if some score lower. "
            f"Prioritize the most share-worthy, attention-grabbing, emotionally impactful moments. "
            f"Each clip must be between {dur_min} and {dur_max} seconds long."
        )
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ]

        for attempt in range(3):
            if cancel_check:
                cancel_check()
            raw = await self._call(messages, max_tokens=8192)
            try:
                raw = raw.strip()
                if raw.startswith("```"):
                    raw = raw.split("\n", 1)[1].rsplit("```", 1)[0]
                data = json.loads(raw)
                clips = []
                for c in data.get("clips", []):
                    duration = c.get("duration", c.get("end_time", 0) - c.get("start_time", 0))
                    if duration < (min_duration or 15) or duration > (max_duration or 600):
                        continue
                    clips.append(ClipCandidate(
                        id=c["id"],
                        title=c.get("title", "Untitled"),
                        start_time=c["start_time"],
                        end_time=c["end_time"],
                        duration=duration,
                        viral_score=max(1, min(100, c.get("viral_score", 50))),
                        viral_score_reasoning=c.get("viral_score_reasoning", ""),
                        clip_type=c.get("clip_type", "highlight"),
                        platform=c.get("platform", "both"),
                        suggested_caption=c.get("suggested_caption", ""),
                        hook_text=c.get("hook_text", ""),
                        why_this_works=c.get("why_this_works", ""),
                    ))
                return clips
            except (json.JSONDecodeError, KeyError) as e:
                logger.warning(f"Attempt {attempt + 1}: Failed to parse Groq clips: {e}")
                if attempt < 2:
                    messages.append({"role": "assistant", "content": raw})
                    messages.append({"role": "user", "content": "Return ONLY valid JSON."})
                continue
        raise ProviderError("Failed to parse viral clips after 3 attempts")

    async def generate_seo(
        self, clip_title: str, clip_transcript: str, video_summary: str,
        platform: str, cancel_check=None,
    ) -> ClipSEO:
        is_description = video_summary.startswith("DESCRIPTION_OVERRIDE")
        if is_description:
            prompt = (
                f"{video_summary}\n\n"
                f"CLIP TITLE: {clip_title}\n"
                f"TARGET PLATFORM: {platform}\n\n"
                f"CLIP TRANSCRIPT:\n{clip_transcript}\n"
            )
        else:
            prompt = (
                f"{DEFAULT_SEO_PROMPT}\n\n"
                f"CLIP TITLE: {clip_title}\n"
                f"TARGET PLATFORM: {platform}\n\n"
                f"VIDEO SUMMARY:\n{video_summary}\n\n"
                f"CLIP TRANSCRIPT:\n{clip_transcript}\n"
            )
        messages = [{"role": "user", "content": prompt}]
        tokens = 16384 if is_description else 4096
        raw = await self._call(messages, max_tokens=tokens)
        try:
            data = normalize_seo_data(extract_json(raw))
            return ClipSEO(**data)
        except Exception:
            logger.warning(f"Failed to parse SEO JSON, using fallback. Raw (first 300): {raw[:300]}")
            desc = extract_description_fallback(raw) if is_description and raw else (raw[:300] if raw else "SEO generation failed")
            return ClipSEO(title=clip_title, description=desc, tags=[], platform_tips="")
