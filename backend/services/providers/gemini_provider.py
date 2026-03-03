import asyncio
import json
import logging
import time
from typing import Optional

import google.generativeai as genai
from PIL import Image

from backend.config import settings
from backend.models import (
    FrameData, SceneDescription, TranscriptSegment, VideoSummary, ClipCandidate, ClipSEO,
)
from backend.services.providers.base import AIProvider, ProviderError, ProviderRateLimitError, extract_json, extract_description_fallback, normalize_seo_data
from backend.services.prompts import DEFAULT_FRAME_ANALYSIS_PROMPT, DEFAULT_VIRAL_CLIP_PROMPT, DEFAULT_SEO_PROMPT
from backend.services.transcript_utils import analyze_transcript_energy, correlate_scenes_with_transcript, derive_content_guidance

logger = logging.getLogger(__name__)

_VISION_TIMEOUT = 120   # 2 min for vision calls
_TEXT_TIMEOUT = 180      # 3 min for text calls


class GeminiProvider(AIProvider):

    def __init__(self):
        genai.configure(api_key=settings.GEMINI_API_KEY)
        self._model = genai.GenerativeModel("gemini-2.0-flash")
        self._total_tokens = 0

    @property
    def supports_vision(self) -> bool:
        return True

    @property
    def provider_name(self) -> str:
        return "gemini"

    async def _call(self, content, max_tokens: int = 4096, timeout: int = _TEXT_TIMEOUT) -> str:
        t0 = time.monotonic()
        try:
            response = await asyncio.wait_for(
                self._model.generate_content_async(
                    content,
                    generation_config=genai.types.GenerationConfig(
                        max_output_tokens=max_tokens,
                        temperature=0.3,
                    ),
                ),
                timeout=timeout,
            )
            elapsed = time.monotonic() - t0
            logger.info("Gemini call completed in %.1fs", elapsed)
            if response.usage_metadata:
                self._total_tokens += (
                    response.usage_metadata.prompt_token_count
                    + response.usage_metadata.candidates_token_count
                )
            return response.text or ""
        except asyncio.TimeoutError:
            logger.error("Gemini call timed out after %ds", timeout)
            raise ProviderError(f"Gemini timeout: no response in {timeout}s")
        except Exception as e:
            err_str = str(e).lower()
            if "429" in str(e) or "quota" in err_str or "rate" in err_str:
                raise ProviderRateLimitError(f"Gemini rate limited: {e}")
            raise ProviderError(f"Gemini error: {e}")

    async def analyze_frames(
        self, frames: list[FrameData], custom_prompt: Optional[str] = None,
        cancel_check=None, progress_callback=None,
    ) -> list[SceneDescription]:
        instruction = custom_prompt if custom_prompt else DEFAULT_FRAME_ANALYSIS_PROMPT
        batch_size = 4
        total = len(frames)
        num_batches = (total + batch_size - 1) // batch_size
        batch_results: list[list[SceneDescription]] = [[] for _ in range(num_batches)]
        frames_completed = 0
        # Process up to 2 batches concurrently
        sem = asyncio.Semaphore(2)

        async def _process_batch(batch_idx: int):
            nonlocal frames_completed
            async with sem:
                if cancel_check:
                    cancel_check()
                start = batch_idx * batch_size
                batch = frames[start : start + batch_size]
                content = [
                    instruction + "\n\n"
                    "Return ONLY valid JSON array:\n"
                    '[{"timestamp": <float>, "description": "<text>", "importance_score": <1-10>, "subject_x": <0-100>}]\n'
                    "IMPORTANT: subject_x is REQUIRED for every frame. Carefully estimate the actual "
                    "horizontal position of the subject's face (0=left edge, 50=center, 100=right edge). "
                    "Do NOT use 50 for every frame — look at where the face actually is."
                ]
                for frame in batch:
                    try:
                        img = Image.open(frame.path)
                        content.append(img)
                        content.append(f"[Frame at {frame.timestamp:.1f}s]")
                    except Exception:
                        content.append(f"[Frame at {frame.timestamp:.1f}s - could not load]")

                raw = await self._call(content, timeout=_VISION_TIMEOUT)
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
                                "Batch %d frame %d: Gemini response missing subject_x field",
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
                    logger.warning(f"Failed to parse Gemini frame analysis: {e}")
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
        raw = await self._call([prompt])
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
        existing_clips: Optional[str] = None,
    ) -> list[ClipCandidate]:
        instruction = custom_prompt if custom_prompt else DEFAULT_VIRAL_CLIP_PROMPT

        # Derive content-type guidance from video summary
        content_guidance = derive_content_guidance(video_summary)

        # Pre-process transcript for energy signals
        energy_text = analyze_transcript_energy(transcript)

        # Correlate scenes with transcript for audio-visual peaks
        av_correlation = correlate_scenes_with_transcript(transcript, scenes)

        # Gemini has large context but cap for response speed
        max_transcript = 40000
        max_scenes = 12000
        transcript_text = "\n".join(
            f"[{s.start:.1f}-{s.end:.1f}] {s.speaker}: {s.text}" for s in transcript
        )
        if len(transcript_text) > max_transcript:
            transcript_text = transcript_text[:max_transcript] + f"\n... (truncated, {len(transcript)} total segments)"

        # Build scene text maintaining chronological order with importance flags
        scene_lines: list[str] = []
        for s in scenes:
            importance_flag = " ★" if s.importance_score >= 7 else ""
            desc_limit = 180 if s.importance_score >= 7 else 100
            desc = s.description[:desc_limit] if len(s.description) > desc_limit else s.description
            scene_lines.append(f"[{s.timestamp:.1f}s] ({s.importance_score}/10{importance_flag}) {desc}")
        scene_text = "\n".join(scene_lines)
        if len(scene_text) > max_scenes:
            scene_text = scene_text[:max_scenes] + f"\n... (truncated, {len(scenes)} total scenes)"

        dur_min = int(min_duration) if min_duration else 30
        dur_max = int(max_duration) if max_duration else 300
        num_clips = clip_count or settings.MAX_CLIP_CANDIDATES
        summary_section = ""
        if video_summary:
            summary_section = f"VIDEO SUMMARY:\n{video_summary}\n\n"

        existing_clips_section = ""
        if existing_clips:
            existing_clips_section = (
                f"\n\nALREADY IDENTIFIED CLIPS (find DIFFERENT moments, do not overlap):\n"
                f"{existing_clips}\n"
                f"Find clips that cover DIFFERENT timestamps and topics from the above."
            )

        prompt = (
            instruction + "\n\n"
            f"{content_guidance}"
            "STRICT REQUIREMENTS:\n"
            f"- Each clip duration MUST be between {dur_min} and {dur_max} seconds\n"
            "- Start at natural speech boundaries — beginning of a sentence, after a pause, at a speaker change\n"
            "- End at natural conclusions — punchlines, resolved thoughts, scene transitions\n"
            "- Must work standalone without context from the full video\n"
            "- The main subject/speaker MUST remain in focus for the entire clip\n"
            "- Do NOT combine scenes from different settings or unrelated topics\n"
            "- When a visual peak (★ scene) coincides with strong transcript content, score that clip higher\n\n"
            f"Video duration: {video_duration:.1f}s\n\n"
            f"{summary_section}"
            f"TRANSCRIPT:\n{transcript_text}\n\n"
            f"SCENES:\n{scene_text}"
            f"{energy_text}"
            f"{av_correlation}"
            f"{existing_clips_section}\n\n"
            f"Return UP TO {num_clips} viral clip candidates, ranked by viral potential from highest to lowest. "
            f"Only return clips that genuinely score 40+ on viral potential. "
            f"It is better to return fewer high-quality clips than to pad with weak filler clips. "
            f"If the video has fewer than {num_clips} genuinely strong moments, return only the strong ones. "
            f"Each clip must be between {dur_min} and {dur_max} seconds long.\n\n"
            "Return ONLY valid JSON:\n"
            '{"clips": [{"id": 1, "title": "...", "start_time": 0.0, "end_time": 0.0, '
            '"duration": 0.0, "viral_score": 50, "viral_score_reasoning": "...", '
            '"clip_type": "highlight", "platform": "both", "suggested_caption": "...", '
            '"hook_text": "...", "why_this_works": "..."}]}'
        )

        for attempt in range(3):
            if cancel_check:
                cancel_check()
            raw = await self._call([prompt], max_tokens=8192)
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
                    # Parse optional focus relevance fields
                    focus_relevance = c.get("focus_relevance")
                    if focus_relevance is not None:
                        focus_relevance = max(1, min(100, int(float(focus_relevance))))
                    focus_tier = c.get("focus_tier")
                    if focus_tier and focus_tier not in ("strong", "moderate", "weak"):
                        focus_tier = None
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
                        focus_relevance=focus_relevance,
                        focus_tier=focus_tier,
                    ))
                return clips
            except (json.JSONDecodeError, KeyError) as e:
                logger.warning(f"Attempt {attempt + 1}: Failed to parse Gemini clips: {e}")
                prompt += "\n\nPrevious response was invalid JSON. Return ONLY valid JSON."
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
        tokens = 16384 if is_description else 4096
        raw = await self._call([prompt], max_tokens=tokens)
        try:
            data = normalize_seo_data(extract_json(raw))
            return ClipSEO(**data)
        except Exception:
            logger.warning(f"Failed to parse SEO JSON, using fallback. Raw (first 300): {raw[:300]}")
            desc = extract_description_fallback(raw) if is_description and raw else (raw[:300] if raw else "SEO generation failed")
            return ClipSEO(title=clip_title, description=desc, tags=[], platform_tips="")
