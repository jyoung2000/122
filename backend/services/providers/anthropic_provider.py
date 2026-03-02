import asyncio
import json
import logging
import time
from typing import Optional

import anthropic

from backend.config import settings
from backend.models import (
    FrameData, SceneDescription, TranscriptSegment, VideoSummary, ClipCandidate, ClipSEO,
)
from backend.services.providers.base import AIProvider, ProviderError, ProviderRateLimitError, extract_json, extract_description_fallback, normalize_seo_data
from backend.services.prompts import DEFAULT_FRAME_ANALYSIS_PROMPT, DEFAULT_VIRAL_CLIP_PROMPT, DEFAULT_SEO_PROMPT

logger = logging.getLogger(__name__)

MODEL = "claude-sonnet-4-6"

_VISION_TIMEOUT = 120   # 2 min for vision calls (per batch)
_TEXT_TIMEOUT = 180      # 3 min for text calls


class AnthropicProvider(AIProvider):

    def __init__(self):
        self._client = anthropic.AsyncAnthropic(api_key=settings.ANTHROPIC_API_KEY)
        self._total_tokens = 0

    @property
    def supports_vision(self) -> bool:
        return True

    @property
    def provider_name(self) -> str:
        return "anthropic"

    async def _call(self, messages: list[dict], system: str = "", max_tokens: int = 4096, timeout: int = _TEXT_TIMEOUT) -> str:
        t0 = time.monotonic()
        try:
            kwargs = {
                "model": MODEL,
                "messages": messages,
                "max_tokens": max_tokens,
                "temperature": 0.3,
            }
            if system:
                kwargs["system"] = system
            response = await asyncio.wait_for(
                self._client.messages.create(**kwargs),
                timeout=timeout,
            )
            elapsed = time.monotonic() - t0
            logger.info("Anthropic call completed in %.1fs", elapsed)
            if response.usage:
                self._total_tokens += response.usage.input_tokens + response.usage.output_tokens
            return response.content[0].text if response.content else ""
        except asyncio.TimeoutError:
            logger.error("Anthropic call timed out after %ds", timeout)
            raise ProviderError(f"Anthropic timeout: no response in {timeout}s")
        except anthropic.RateLimitError as e:
            raise ProviderRateLimitError(f"Anthropic rate limited: {e}")
        except Exception as e:
            raise ProviderError(f"Anthropic error: {e}")

    async def analyze_frames(
        self, frames: list[FrameData], custom_prompt: Optional[str] = None,
        cancel_check=None, progress_callback=None,
    ) -> list[SceneDescription]:
        instruction = custom_prompt if custom_prompt else DEFAULT_FRAME_ANALYSIS_PROMPT
        batch_size = 4
        total = len(frames)
        num_batches = (total + batch_size - 1) // batch_size
        # Store results per batch index to maintain ordering
        batch_results: list[list[SceneDescription]] = [[] for _ in range(num_batches)]
        frames_completed = 0
        # Process up to 2 batches concurrently — queue the next API call
        # while the previous response is in flight.
        sem = asyncio.Semaphore(2)

        async def _process_batch(batch_idx: int):
            nonlocal frames_completed
            async with sem:
                if cancel_check:
                    cancel_check()
                start = batch_idx * batch_size
                batch = frames[start : start + batch_size]
                content: list[dict] = [
                    {"type": "text", "text": (
                        instruction + "\n\n"
                        "Return ONLY valid JSON array:\n"
                        '[{"timestamp": <float>, "description": "<text>", "importance_score": <1-10>, "subject_x": <0-100>}]\n'
                        "IMPORTANT: subject_x is REQUIRED for every frame. Carefully estimate the actual "
                        "horizontal position of the subject's face (0=left edge, 50=center, 100=right edge). "
                        "Do NOT use 50 for every frame — look at where the face actually is."
                    )},
                ]
                for frame in batch:
                    if frame.base64:
                        content.append({
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": "image/jpeg",
                                "data": frame.base64,
                            },
                        })
                        content.append({
                            "type": "text",
                            "text": f"[Frame at {frame.timestamp:.1f}s]",
                        })
                messages = [{"role": "user", "content": content}]
                raw = await self._call(messages, timeout=_VISION_TIMEOUT)
                try:
                    raw = raw.strip()
                    if raw.startswith("```"):
                        raw = raw.split("\n", 1)[1].rsplit("```", 1)[0]
                    parsed = json.loads(raw)
                    if not isinstance(parsed, list):
                        parsed = [parsed]
                    for idx, item in enumerate(parsed):
                        frame_ref = batch[idx] if idx < len(batch) else batch[-1]
                        sx = item.get("subject_x")
                        if sx is None:
                            logger.warning(
                                "Batch %d frame %d: Anthropic response missing subject_x field",
                                batch_idx, idx,
                            )
                            sx = 50
                        else:
                            sx = max(0, min(100, int(sx)))
                        batch_results[batch_idx].append(SceneDescription(
                            timestamp=item.get("timestamp", frame_ref.timestamp),
                            description=item.get("description", ""),
                            importance_score=max(1, min(10, int(item.get("importance_score", 5)))),
                            thumbnail_path=frame_ref.path,
                            subject_x=sx,
                        ))
                except (json.JSONDecodeError, KeyError, IndexError) as e:
                    logger.warning(f"Failed to parse Anthropic frame analysis: {e}")
                    for frame in batch:
                        batch_results[batch_idx].append(SceneDescription(
                            timestamp=frame.timestamp,
                            description=raw[:200] if raw else "Analysis failed",
                            importance_score=5,
                            thumbnail_path=frame.path,
                            subject_x=50,
                        ))
                frames_completed += len(batch)
                if progress_callback:
                    await progress_callback(min(frames_completed, total), total)

        await asyncio.gather(*[_process_batch(i) for i in range(num_batches)])
        # Flatten results in batch order
        scenes = []
        for batch_scene_list in batch_results:
            scenes.extend(batch_scene_list)
        return scenes

    async def generate_summary(
        self,
        transcript: list[TranscriptSegment],
        scenes: list[SceneDescription],
        cancel_check=None,
    ) -> VideoSummary:
        transcript_text = "\n".join(
            f"[{s.start:.1f}-{s.end:.1f}] {s.speaker}: {s.text}" for s in transcript
        )
        scene_text = "\n".join(
            f"[{s.timestamp:.1f}s] (importance: {s.importance_score}/10) {s.description}"
            for s in scenes
        )
        prompt = (
            "Based on the transcript and scene descriptions below, generate a content summary.\n\n"
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
            return VideoSummary(
                overview=raw[:500],
                key_topics=["Unable to parse"],
                tone="unknown",
                estimated_audience="general",
                content_category="uncategorized",
            )

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
    ) -> list[ClipCandidate]:
        instruction = custom_prompt if custom_prompt else DEFAULT_VIRAL_CLIP_PROMPT
        # Claude has large context but cap to avoid very slow responses
        max_transcript = 30000
        max_scenes = 10000
        transcript_text = "\n".join(
            f"[{s.start:.1f}-{s.end:.1f}] {s.speaker}: {s.text}" for s in transcript
        )
        if len(transcript_text) > max_transcript:
            transcript_text = transcript_text[:max_transcript] + f"\n... (truncated, {len(transcript)} total segments)"
        scene_text = "\n".join(
            f"[{s.timestamp:.1f}s] (importance: {s.importance_score}/10) {s.description}"
            for s in scenes
        )
        if len(scene_text) > max_scenes:
            scene_text = scene_text[:max_scenes] + f"\n... (truncated, {len(scenes)} total scenes)"
        dur_min = int(min_duration) if min_duration else 30
        dur_max = int(max_duration) if max_duration else 300
        num_clips = clip_count or settings.MAX_CLIP_CANDIDATES
        system_prompt = (
            instruction + "\n\n"
            "STRICT REQUIREMENTS:\n"
            f"- Each clip duration MUST be between {dur_min} and {dur_max} seconds\n"
            "- Natural start point - never mid-sentence or mid-thought\n"
            "- Natural end point - conclusion, punchline, or resolution\n"
            "- Must work standalone without context from the full video\n"
            "- The main subject/speaker MUST remain in focus for the entire clip\n"
            "- Do NOT combine scenes from different settings or unrelated topics into one clip\n"
            "- Prioritize: strong hooks in first 3 seconds, emotional peaks, surprising moments, "
            "clear value delivery, quotable statements, visual highlights\n\n"
            "Return ONLY valid JSON, no other text:\n"
            '{"clips": [{"id": 1, "title": "...", "start_time": 45.2, "end_time": 112.8, '
            '"duration": 67.6, "viral_score": 87, "viral_score_reasoning": "...", '
            '"clip_type": "informative", "platform": "both", "suggested_caption": "...", '
            '"hook_text": "...", "why_this_works": "..."}]}'
        )
        summary_section = ""
        if video_summary:
            summary_section = f"VIDEO SUMMARY:\n{video_summary}\n\n"
        user_prompt = (
            f"Video duration: {video_duration:.1f} seconds\n\n"
            f"{summary_section}"
            f"TRANSCRIPT:\n{transcript_text}\n\n"
            f"SCENE DESCRIPTIONS:\n{scene_text}\n\n"
            f"You MUST return exactly {num_clips} viral clip candidates, ranked by viral potential from highest to lowest. "
            f"Do NOT return fewer than {num_clips} clips — find {num_clips} distinct moments even if some score lower. "
            f"Prioritize the most share-worthy, attention-grabbing, emotionally impactful moments. "
            f"Each clip must be between {dur_min} and {dur_max} seconds long."
        )
        messages = [{"role": "user", "content": user_prompt}]

        for attempt in range(3):
            if cancel_check:
                cancel_check()
            raw = await self._call(messages, system=system_prompt, max_tokens=8192)
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
                logger.warning(f"Attempt {attempt + 1}: Failed to parse clips: {e}")
                if attempt < 2:
                    messages.append({"role": "assistant", "content": raw})
                    messages.append({
                        "role": "user",
                        "content": "That was not valid JSON. Return ONLY valid JSON.",
                    })
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
