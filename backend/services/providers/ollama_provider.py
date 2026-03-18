import asyncio
import json
import logging
from typing import Optional

import httpx

from backend.config import settings
from backend.models import (
    FrameData, SceneDescription, TranscriptSegment, VideoSummary, ClipCandidate, ClipSEO,
)
from backend.services.providers.base import AIProvider, ProviderError, extract_json, extract_description_fallback, normalize_seo_data, build_fallback_summary, has_real_summary_content, build_summary_from_transcript
from backend.services.prompts import DEFAULT_FRAME_ANALYSIS_PROMPT, DEFAULT_VIRAL_CLIP_PROMPT, DEFAULT_SEO_PROMPT, DEFAULT_SUMMARY_PROMPT
from backend.services.transcript_utils import analyze_transcript_energy, correlate_scenes_with_transcript, derive_content_guidance
from backend.services.hot_zone_scorer import format_hot_zones_for_prompt

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

# Minimal prompt for two-stage vision fast scan
_QUICK_SCAN_PROMPT = (
    "Rate this frame's visual interest from 1-10. "
    'Return ONLY a JSON object: {"score": <int>}'
)

# Default concurrency for vision frame analysis (set to 2 if VRAM >6GB)
VISION_CONCURRENCY = 1

logger = logging.getLogger(__name__)


def _truncate_at_boundary(text: str, max_chars: int) -> str:
    """Truncate text at the nearest sentence/segment boundary before max_chars."""
    if len(text) <= max_chars:
        return text
    # Find the last newline before the limit (segment boundary)
    cut = text.rfind("\n", 0, max_chars)
    if cut > max_chars * 0.7:  # Don't lose more than 30%
        return text[:cut]
    # Fall back to last period
    cut = text.rfind(". ", 0, max_chars)
    if cut > max_chars * 0.7:
        return text[:cut + 1]
    return text[:max_chars]


class OllamaProvider(AIProvider):
    """Local Ollama provider - always available as final fallback."""

    def __init__(self):
        self._host = settings.OLLAMA_HOST
        self._vision_model = settings.OLLAMA_VISION_MODEL
        self._text_model = settings.OLLAMA_TEXT_MODEL
        self._summary_model = self._text_model
        self._total_tokens = 0
        self._model_ctx: dict[str, int] = {}
        # Shared connection pool — reused across all API calls
        self._client = httpx.AsyncClient(
            timeout=httpx.Timeout(120.0, connect=10.0),
            limits=httpx.Limits(max_connections=4, max_keepalive_connections=2),
        )

    async def close(self):
        """Close the shared HTTP client. Call when provider is no longer needed."""
        await self._client.aclose()

    @property
    def supports_vision(self) -> bool:
        return True

    @property
    def provider_name(self) -> str:
        return "ollama"

    @property
    def text_model_name(self) -> str:
        return self._text_model

    async def warmup(self):
        """Pre-load models into VRAM to avoid cold start on first analysis."""
        try:
            # Load vision model
            await self._client.post(f"{self._host}/api/chat", json={
                "model": self._vision_model,
                "messages": [{"role": "user", "content": "test"}],
                "stream": False,
                "options": {"num_predict": 1},
            })
            # Load text model
            await self._client.post(f"{self._host}/api/chat", json={
                "model": self._text_model,
                "messages": [{"role": "user", "content": "test"}],
                "stream": False,
                "options": {"num_predict": 1},
            })
            logger.info("Ollama models warmed up: vision=%s, text=%s",
                        self._vision_model, self._text_model)
        except Exception as e:
            logger.warning("Ollama warmup failed (non-fatal): %s", e)

    async def _detect_capabilities(self):
        """Probe Ollama for model capabilities to adapt prompt sizing."""
        try:
            for model_name in [self._vision_model, self._text_model]:
                resp = await self._client.post(f"{self._host}/api/show", json={"model": model_name})
                if resp.status_code == 200:
                    info = resp.json()
                    params = info.get("details", {}).get("parameter_size", "")
                    quant = info.get("details", {}).get("quantization_level", "")
                    ctx_length = info.get("model_info", {}).get("context_length", 2048)
                    logger.info("Ollama model %s: params=%s, quant=%s, ctx=%d",
                                model_name, params, quant, ctx_length)
                    self._model_ctx[model_name] = ctx_length
        except Exception as e:
            logger.warning("Ollama capability detection failed: %s", e)

    async def _call_vision(self, prompt: str, image_base64: str) -> str:
        """Send ONE frame at a time to the vision model via /api/chat."""
        try:
            response = await self._client.post(
                f"{self._host}/api/chat",
                json={
                    "model": self._vision_model,
                    "messages": [
                        {
                            "role": "user",
                            "content": prompt,
                            "images": [image_base64],
                        }
                    ],
                    "stream": False,
                    "options": {
                        "num_ctx": 2048,
                    },
                },
            )
            response.raise_for_status()
            data = response.json()
            self._total_tokens += data.get("prompt_eval_count", 0) + data.get("eval_count", 0)
            return data.get("message", {}).get("content", "")
        except Exception as e:
            raise ProviderError(f"Ollama vision error: {e}")

    async def _call_text(self, prompt: str, system: str = "", max_tokens: int = 4096,
                         timeout: float = 90.0, json_mode: bool = False) -> str:
        try:
            messages = []
            if system:
                messages.append({"role": "system", "content": system})
            messages.append({"role": "user", "content": prompt})

            payload = {
                "model": self._text_model,
                "messages": messages,
                "stream": False,
                "options": {
                    "num_predict": max_tokens,
                    "num_ctx": self._model_ctx.get(self._text_model, 4096),
                    "temperature": 0.3,
                },
            }
            if json_mode:
                payload["format"] = "json"
            logger.debug("Ollama _call_text (chat): model=%s, prompt_len=%d, system_len=%d, timeout=%.0fs",
                         self._text_model, len(prompt), len(system), timeout)
            response = await self._client.post(
                f"{self._host}/api/chat",
                json=payload,
                timeout=timeout,
            )
            response.raise_for_status()
            data = response.json()
            self._total_tokens += data.get("prompt_eval_count", 0) + data.get("eval_count", 0)
            result = data.get("message", {}).get("content", "")
            if not result:
                logger.warning("Ollama returned empty response for model=%s", self._text_model)
            return result
        except httpx.TimeoutException:
            raise ProviderError(f"Ollama text timeout after {timeout}s (model={self._text_model})")
        except httpx.HTTPStatusError as e:
            raise ProviderError(f"Ollama HTTP {e.response.status_code}: {e.response.text[:200]}")
        except Exception as e:
            raise ProviderError(f"Ollama text error ({type(e).__name__}): {e}")

    async def text_complete(self, prompt: str, max_tokens: int = 4096, timeout: int | None = None) -> str:
        return await self._call_text(prompt, max_tokens=max_tokens)

    async def analyze_frames(
        self, frames: list[FrameData], custom_prompt: Optional[str] = None,
        cancel_check=None, progress_callback=None,
    ) -> list[SceneDescription]:
        instruction = custom_prompt if custom_prompt else DEFAULT_FRAME_ANALYSIS_PROMPT
        total = len(frames)

        # Two-stage vision: fast scan to identify interesting frames, then detailed analysis
        interesting_indices = set(range(total))  # default: all frames
        if total > 10:
            # Stage 1: Quick scan to identify visually interesting frames
            quick_scores = []
            for fi, frame in enumerate(frames):
                if cancel_check:
                    cancel_check()
                if not frame.base64:
                    quick_scores.append(0)
                    continue
                try:
                    raw = await self._call_vision(_QUICK_SCAN_PROMPT, frame.base64)
                    text = raw.strip()
                    if text.startswith("```"):
                        text = text.split("\n", 1)[1].rsplit("```", 1)[0].strip()
                    json_start = text.find("{")
                    json_end = text.rfind("}") + 1
                    if json_start >= 0 and json_end > json_start:
                        parsed = json.loads(text[json_start:json_end])
                        score = int(parsed.get("score", 5))
                    else:
                        score = 5
                    quick_scores.append(score)
                except Exception:
                    quick_scores.append(5)  # assume interesting on failure

            # Keep frames scoring 5+ and always include first and last
            interesting_indices = {0, total - 1}
            for i, score in enumerate(quick_scores):
                if score >= 5:
                    interesting_indices.add(i)

            skipped = total - len(interesting_indices)
            if skipped > 0:
                logger.info("Two-stage vision: skipping %d/%d low-interest frames", skipped, total)

        # Stage 2: Full analysis with concurrency limiter
        sem = asyncio.Semaphore(VISION_CONCURRENCY)
        scenes: list[Optional[SceneDescription]] = [None] * total
        completed = 0

        async def _analyze_one(fi: int, frame: FrameData):
            nonlocal completed
            async with sem:
                if cancel_check:
                    cancel_check()
                if not frame.base64 or fi not in interesting_indices:
                    completed += 1
                    if progress_callback:
                        await progress_callback(completed, total)
                    return

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
                    scenes[fi] = SceneDescription(
                        timestamp=frame.timestamp,
                        description=description,
                        importance_score=importance,
                        thumbnail_path=frame.path,
                        subject_x=subject_x,
                    )
                except Exception as e:
                    logger.warning(f"Ollama frame analysis failed for {frame.timestamp}s: {e}")
                    scenes[fi] = SceneDescription(
                        timestamp=frame.timestamp,
                        description="Analysis failed (local AI)",
                        importance_score=5,
                        thumbnail_path=frame.path,
                        subject_x=50,
                    )
                completed += 1
                if progress_callback:
                    await progress_callback(completed, total)

        # Run with concurrency limiter (sequential when VISION_CONCURRENCY=1)
        await asyncio.gather(*[_analyze_one(i, f) for i, f in enumerate(frames)])
        return [s for s in scenes if s is not None]

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
            f"TRANSCRIPT:\n{_truncate_at_boundary(transcript_text, 3000)}\n\n"
            f"SCENES:\n{_truncate_at_boundary(scene_text, 1000)}\n\n"
            "Return ONLY valid JSON:\n"
            '{"overview": "<paragraph>", "key_topics": ["topic1", "topic2"], '
            '"tone": "<tone>", "estimated_audience": "<audience>", "content_category": "<category>"}'
        )
        raw = await self._call_text(prompt, json_mode=True)
        try:
            data = extract_json(raw)
            if not has_real_summary_content(data):
                logger.warning("Summary JSON has placeholder values, trying fallback extraction")
                raise ValueError("Placeholder values detected in summary")
            return VideoSummary(**data)
        except Exception:
            logger.warning("Failed to parse summary JSON, using fallback extraction. Raw (first 300): %s", raw[:300])
            fb = build_fallback_summary(raw)
            if not has_real_summary_content(fb):
                logger.warning("Fallback extraction also produced placeholders, building from transcript")
                fb = build_summary_from_transcript(transcript, scenes)
            return VideoSummary(**fb)

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
        hot_zones=None,
        progress_callback=None,
    ) -> list[ClipCandidate]:
        # For videos > 5 min, use windowed detection
        if video_duration > 300:
            logger.info("Ollama: video %.0fs (>5min) — using windowed clip detection", video_duration)
            return await self._windowed_clip_detection(
                transcript, scenes, video_duration,
                custom_prompt=custom_prompt, cancel_check=cancel_check,
                clip_count=clip_count, min_duration=min_duration,
                max_duration=max_duration, video_summary=video_summary,
                existing_clips=existing_clips,
                hot_zones=hot_zones,
                progress_callback=progress_callback,
            )
        return await self._single_pass_clip_detection(
            transcript, scenes, video_duration,
            custom_prompt=custom_prompt, cancel_check=cancel_check,
            clip_count=clip_count, min_duration=min_duration,
            max_duration=max_duration, video_summary=video_summary,
            existing_clips=existing_clips,
            hot_zones=hot_zones,
            progress_callback=progress_callback,
        )

    async def _single_pass_clip_detection(
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
        hot_zones=None,
        progress_callback=None,
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
        )
        transcript_text = _truncate_at_boundary(transcript_text, 4000)

        scene_text = "\n".join(
            f"[{s.timestamp:.0f}s] {s.description[:80]}" for s in scenes
        ) if scenes else ""
        scene_text = _truncate_at_boundary(scene_text, 1500)

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

        # Enrich prompt with energy analysis (same as OpenRouter)
        enrichment = ""
        energy_text = analyze_transcript_energy(transcript, max_moments=15)
        correlation_text = correlate_scenes_with_transcript(transcript, scenes)
        guidance_text = derive_content_guidance(video_summary or "")

        if energy_text:
            enrichment += f"\nENERGY MAP (high-engagement moments):\n{_truncate_at_boundary(energy_text, 800)}\n"
        if correlation_text:
            enrichment += f"\nAUDIO-VISUAL CORRELATION:\n{_truncate_at_boundary(correlation_text, 500)}\n"
        if guidance_text:
            enrichment += f"\nCONTENT GUIDANCE:\n{_truncate_at_boundary(guidance_text, 300)}\n"

        # Inject hot zone data if available
        if hot_zones:
            hz_text = format_hot_zones_for_prompt(hot_zones)
            if hz_text:
                enrichment += f"\n{_truncate_at_boundary(hz_text, 600)}\n"

        # Summary-aware clip detection: include full summary for context
        summary_section = ""
        if video_summary:
            vs = video_summary[:1000] if len(video_summary) > 1000 else video_summary
            summary_section = (
                f"VIDEO SUMMARY (use this to ensure clip selections align with the video's main themes):\n{vs}\n\n"
            )

        prompt = (
            f"Video duration: {video_duration:.1f}s\n\n"
            f"{summary_section}"
            f"TRANSCRIPT:\n{transcript_text}\n\n"
            f"SCENES:\n{scene_text}\n\n"
            f"{enrichment}\n"
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

        original_prompt = prompt
        for attempt in range(3):
            if cancel_check:
                cancel_check()
            # Use longer timeout for clip detection — local models are slow
            raw = await self._call_text(prompt, system=system, max_tokens=4096, timeout=110.0, json_mode=True)
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
                # Retry with correction context (retry-and-refine)
                if attempt < 2:
                    prompt = (
                        f"Your previous response was not valid JSON. The error was: {e}\n"
                        f"Your raw output was:\n{raw[:500]}\n\n"
                        f"Please fix and return ONLY valid JSON with the clips array.\n"
                        f"Original request:\n{_truncate_at_boundary(original_prompt, 2000)}"
                    )
                    logger.info("Attempt %d: retrying with correction context", attempt + 1)
                else:
                    logger.warning(f"Attempt {attempt + 1}: Ollama clips parse failed: {e}")
                continue
        raise ProviderError("Ollama: failed to parse viral clips after 3 attempts")

    async def _windowed_clip_detection(
        self,
        transcript: list[TranscriptSegment],
        scenes: list[SceneDescription],
        video_duration: float,
        window_duration: float = 300.0,  # 5 min windows (fits 3B context)
        overlap_duration: float = 60.0,
        **kwargs,
    ) -> list[ClipCandidate]:
        """Sequential windowed detection for long videos."""
        windows = []
        window_start = 0.0
        while window_start < video_duration:
            window_end = min(window_start + window_duration, video_duration)
            windows.append((window_start, window_end))
            window_start += window_duration - overlap_duration

        all_clips = []
        for idx, (w_start, w_end) in enumerate(windows):
            if kwargs.get("cancel_check"):
                kwargs["cancel_check"]()

            window_transcript = [
                seg for seg in transcript
                if seg.start >= w_start - overlap_duration / 2
                and seg.end <= w_end + overlap_duration / 2
            ]
            window_scenes = [
                s for s in scenes
                if s.timestamp >= w_start and s.timestamp <= w_end
            ]

            logger.info(
                "Ollama window %d/%d: %.0f-%.0fs (%d segments, %d scenes)",
                idx + 1, len(windows), w_start, w_end,
                len(window_transcript), len(window_scenes),
            )

            try:
                clips = await self._single_pass_clip_detection(
                    window_transcript, window_scenes, w_end - w_start,
                    **kwargs,
                )
                # Offset clip times back to absolute video time
                for clip in clips:
                    clip.start_time += w_start
                    clip.end_time += w_start
                all_clips.extend(clips)
            except Exception as e:
                logger.warning("Ollama window %d clip detection failed: %s", idx + 1, e)

        # Deduplicate overlapping clips
        return self._deduplicate_clips(all_clips)

    @staticmethod
    def _deduplicate_clips(clips: list[ClipCandidate], max_overlap: float = 0.5) -> list[ClipCandidate]:
        """Remove clips that overlap by more than max_overlap fraction of the shorter clip."""
        if len(clips) <= 1:
            return clips

        # Sort by viral_score descending so we keep the best clip in each overlap group
        sorted_clips = sorted(clips, key=lambda c: c.viral_score, reverse=True)
        kept = []

        for clip in sorted_clips:
            is_duplicate = False
            for existing in kept:
                # Calculate overlap
                overlap_start = max(clip.start_time, existing.start_time)
                overlap_end = min(clip.end_time, existing.end_time)
                overlap_duration = max(0, overlap_end - overlap_start)
                shorter_duration = min(clip.duration, existing.duration)

                if shorter_duration > 0 and overlap_duration / shorter_duration > max_overlap:
                    is_duplicate = True
                    logger.info(
                        "De-dup: dropping '%s' (%.0f-%.0fs, score=%d) — overlaps %.0f%% with '%s'",
                        clip.title, clip.start_time, clip.end_time, clip.viral_score,
                        (overlap_duration / shorter_duration) * 100, existing.title,
                    )
                    break

            if not is_duplicate:
                kept.append(clip)

        if len(kept) < len(clips):
            logger.info("De-duplication: kept %d of %d clips", len(kept), len(clips))
        return kept

    async def generate_seo(
        self, clip_title: str, clip_transcript: str, video_summary: str,
        platform: str, cancel_check=None, custom_prompt=None,
    ) -> ClipSEO:
        seo_instruction = custom_prompt if custom_prompt else DEFAULT_SEO_PROMPT
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
                f"{seo_instruction}\n\n"
                f"CLIP TITLE: {clip_title}\n"
                f"TARGET PLATFORM: {platform}\n\n"
                f"VIDEO SUMMARY:\n{video_summary[:1000]}\n\n"
                f"CLIP TRANSCRIPT:\n{clip_transcript[:2000]}\n"
            )
        tokens = 16384 if is_description else 4096
        raw = await self._call_text(prompt, max_tokens=tokens, json_mode=True)
        try:
            data = normalize_seo_data(extract_json(raw))
            return ClipSEO(**data)
        except Exception:
            logger.warning(f"Failed to parse SEO JSON, using fallback. Raw (first 300): {raw[:300]}")
            desc = extract_description_fallback(raw) if is_description and raw else (raw[:300] if raw else "SEO generation failed (local AI)")
            return ClipSEO(title=clip_title, description=desc, tags=[], platform_tips="")
