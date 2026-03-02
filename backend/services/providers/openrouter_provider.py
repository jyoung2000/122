import asyncio
import base64
import json
import time
import logging
from typing import Optional

from openai import AsyncOpenAI

from backend.config import settings
from backend.models import (
    FrameData, SceneDescription, TranscriptSegment, VideoSummary, ClipCandidate, ClipSEO,
)
from backend.services.providers.base import AIProvider, ProviderError, ProviderRateLimitError, extract_json, normalize_seo_data
from backend.services.prompts import DEFAULT_FRAME_ANALYSIS_PROMPT, DEFAULT_VIRAL_CLIP_PROMPT, DEFAULT_SEO_PROMPT

logger = logging.getLogger(__name__)

# ── Model presets ──────────────────────────────────────────────────────
# Each preset targets a different cost / quality tradeoff on OpenRouter.
# "free"       → zero-cost community endpoints (rate-limited)
# "efficient"  → cheapest paid models with good quality
# "balanced"   → mid-tier, great quality-to-cost ratio
# "premium"    → top-tier frontier models
#
# NOTE: These are hardcoded defaults that may become outdated as
# OpenRouter rotates free models. The app dynamically discovers
# available models via /api/providers/models/recommended and the
# user can refresh the list from the Settings UI.
PRESETS = {
    "free": {
        # openrouter/free auto-routes to whatever free model is currently available
        "vision": "openrouter/free",
        "summary": "openrouter/free",
        "text": "openrouter/free",
        # Ordered by reliability + vision quality for free models.
        # Google Gemini models are included as final fallbacks because
        # :free models often return 401 "User not found" for API keys
        # that don't have free-tier access.  Gemini models use Google's
        # own auth path via OpenRouter and work with most API keys.
        "vision_fallbacks": [
            "qwen/qwen2.5-vl-72b-instruct:free",
            "qwen/qwen2.5-vl-32b-instruct:free",
            "google/gemma-3-27b-it:free",
            "meta-llama/llama-3.2-11b-vision-instruct:free",
            "mistralai/mistral-small-3.1-24b-instruct:free",
            "google/gemini-2.5-flash",
        ],
        "summary_fallbacks": [
            "google/gemma-3-27b-it:free",
            "mistralai/mistral-small-3.1-24b-instruct:free",
            "meta-llama/llama-3.2-11b-vision-instruct:free",
            "google/gemini-2.5-flash",
            "google/gemini-2.5-flash-lite",
        ],
        "text_fallbacks": [
            "google/gemma-3-27b-it:free",
            "mistralai/mistral-small-3.1-24b-instruct:free",
            "meta-llama/llama-3.2-11b-vision-instruct:free",
            "google/gemini-2.5-flash",
            "google/gemini-2.5-flash-lite",
        ],
    },
    "efficient": {
        "vision": "google/gemini-2.5-flash",
        "summary": "google/gemini-2.5-flash",
        "text": "google/gemini-2.5-flash",
        "vision_fallbacks": [
            "google/gemini-2.5-flash-lite",
        ],
        "summary_fallbacks": [
            "google/gemini-2.5-flash-lite",
        ],
        "text_fallbacks": [
            "google/gemini-2.5-flash-lite",
        ],
    },
    "balanced": {
        "vision": "google/gemini-2.5-flash",
        "summary": "google/gemini-2.5-flash",
        "text": "google/gemini-2.5-pro",
        "vision_fallbacks": [
            "google/gemini-2.5-flash-lite",
        ],
        "summary_fallbacks": [
            "google/gemini-2.5-pro",
            "google/gemini-2.5-flash-lite",
        ],
        "text_fallbacks": [
            "google/gemini-2.5-flash",
            "google/gemini-2.5-flash-lite",
        ],
    },
    "premium": {
        "vision": "google/gemini-2.5-pro",
        "summary": "google/gemini-2.5-flash",
        "text": "anthropic/claude-sonnet-4",
        "vision_fallbacks": [
            "google/gemini-2.5-flash",
        ],
        "summary_fallbacks": [
            "google/gemini-2.5-pro",
            "google/gemini-2.5-flash-lite",
        ],
        "text_fallbacks": [
            "google/gemini-2.5-pro",
            "google/gemini-2.5-flash",
        ],
    },
}


class _RateLimiter:
    """Token bucket rate limiter: max RPM with minimum interval between requests."""

    def __init__(self, max_rpm: int = 18, min_interval: float = 3.0):
        self._max_rpm = max_rpm
        self._min_interval = min_interval
        self._timestamps: list[float] = []
        self._lock = asyncio.Lock()

    async def acquire(self):
        async with self._lock:
            now = time.monotonic()
            self._timestamps = [t for t in self._timestamps if now - t < 60]
            if self._timestamps:
                elapsed = now - self._timestamps[-1]
                if elapsed < self._min_interval:
                    await asyncio.sleep(self._min_interval - elapsed)
            if len(self._timestamps) >= self._max_rpm:
                wait = 60 - (now - self._timestamps[0])
                if wait > 0:
                    await asyncio.sleep(wait)
            self._timestamps.append(time.monotonic())


class OpenRouterProvider(AIProvider):
    """Proxies to various models via OpenRouter's unified API."""

    # Approximate context window budgets (in chars, ~4 chars/token) per model pattern.
    # Used to scale prompt condensation to fit the model's input limits.
    # Conservative estimates — leaves room for the system prompt + output tokens.
    _MODEL_CONTEXT_BUDGET = {
        "openrouter/free": 6000,       # free auto-route → unpredictable, be very conservative
        "gemma": 6000,                 # Gemma models: 8K context
        "llama": 8000,                 # Llama models: 8-16K context
        "qwen": 10000,                 # Qwen models: 32K+ context
        "gemini-2.5-flash": 40000,     # Gemini Flash: 1M context
        "gemini-2.5-pro": 40000,       # Gemini Pro: 1M context
        "claude": 30000,               # Claude: 200K context
        "gpt-4": 20000,                # GPT-4: 128K context
    }
    _DEFAULT_CONTEXT_BUDGET = 12000    # safe default for unknown models

    def _get_context_budget(self, model: str) -> int:
        """Return the approximate char budget for prompt content based on model."""
        model_lower = model.lower()
        for pattern, budget in self._MODEL_CONTEXT_BUDGET.items():
            if pattern in model_lower:
                return budget
        return self._DEFAULT_CONTEXT_BUDGET

    def __init__(self):
        self._client = AsyncOpenAI(
            base_url="https://openrouter.ai/api/v1",
            api_key=settings.OPENROUTER_API_KEY,
            default_headers={
                "HTTP-Referer": "http://localhost:1353",
                "X-Title": "ClipAI",
            },
        )
        self._preset_name = settings.OPENROUTER_PRESET
        # When preset is "custom" (user picked specific models), there's no
        # entry in PRESETS — fall back to "balanced" for sensible fallback
        # models.  The old code fell back to PRESETS["free"] whose `:free`
        # model fallbacks return 401 "User not found" for many API keys
        # (free-tier models use a different auth path on OpenRouter).
        # "balanced" provides Google model fallbacks which work reliably.
        preset = PRESETS.get(self._preset_name, PRESETS["balanced"])

        # Always use the current model IDs from settings — these reflect
        # the user's most recent selection (whether from a preset or custom
        # model picker).  When a preset is selected via /providers/preset,
        # the settings model IDs are updated to match.  When the user picks
        # specific models via /providers/models/save, the preset switches
        # to "custom" and the model IDs are set directly.
        #
        # Fall back to preset defaults only when settings are empty/unset
        # (e.g. fresh container with no persisted user_settings.json).
        self._vision_model = settings.OPENROUTER_VISION_MODEL or preset["vision"]
        self._text_model = settings.OPENROUTER_TEXT_MODEL or preset["text"]
        self._summary_model = settings.OPENROUTER_SUMMARY_MODEL or self._text_model

        # Store fallback model lists from preset.
        # Support both old single-fallback keys and new list keys.
        def _to_list(key_list, key_single, default=None):
            val = preset.get(key_list)
            if val:
                return list(val)
            single = preset.get(key_single)
            return [single] if single else (list(default) if default else [])

        self._vision_fallbacks = _to_list("vision_fallbacks", "vision_fallback")
        self._text_fallbacks = _to_list("text_fallbacks", "text_fallback")
        self._summary_fallbacks = _to_list(
            "summary_fallbacks", "summary_fallback", self._text_fallbacks,
        )
        self._rate_limiter = (
            _RateLimiter()
            if self._preset_name == "free"
            else _RateLimiter(max_rpm=60, min_interval=0.5)
        )
        self._total_tokens = 0
        self._total_cost = 0.0
        logger.info(
            f"OpenRouter init: preset={self._preset_name}, "
            f"vision={self._vision_model} (+{len(self._vision_fallbacks)} fallbacks), "
            f"summary={self._summary_model} (+{len(self._summary_fallbacks)} fallbacks), "
            f"clip={self._text_model} (+{len(self._text_fallbacks)} fallbacks)"
        )

    @property
    def supports_vision(self) -> bool:
        return True

    @property
    def provider_name(self) -> str:
        return "openrouter"

    _API_TIMEOUT = 180  # 3 minutes per API call

    async def _call(self, model: str, messages: list[dict], max_tokens: int = 4096, timeout: int | None = None) -> str:
        await self._rate_limiter.acquire()
        call_timeout = timeout or self._API_TIMEOUT
        t0 = time.monotonic()
        try:
            response = await asyncio.wait_for(
                self._client.chat.completions.create(
                    model=model,
                    messages=messages,
                    max_tokens=max_tokens,
                    temperature=0.3,
                ),
                timeout=call_timeout,
            )
            elapsed = time.monotonic() - t0
            logger.info("OpenRouter call to %s completed in %.1fs", model, elapsed)
            if response.usage:
                self._total_tokens += response.usage.total_tokens
            if not response.choices:
                logger.warning("OpenRouter %s returned empty/null choices", model)
                raise ProviderError(f"OpenRouter empty response ({model}): no choices returned")
            return response.choices[0].message.content or ""
        except asyncio.TimeoutError:
            logger.error("OpenRouter call to %s timed out after %ds", model, call_timeout)
            raise ProviderError(f"OpenRouter timeout ({model}): no response in {call_timeout}s")
        except ProviderError:
            raise
        except Exception as e:
            err_str = str(e)
            # Retry on rate limits (429) or transient server errors (5xx)
            is_rate_limit = "429" in err_str or "rate" in err_str.lower()
            is_server_error = any(code in err_str for code in ("500", "502", "503", "504"))
            if is_rate_limit or is_server_error:
                wait_s = 5 if is_rate_limit else 3
                logger.warning(
                    "OpenRouter %s on %s, waiting %ds before retry...",
                    "rate limited" if is_rate_limit else "server error",
                    model, wait_s,
                )
                await asyncio.sleep(wait_s)
                try:
                    response = await asyncio.wait_for(
                        self._client.chat.completions.create(
                            model=model,
                            messages=messages,
                            max_tokens=max_tokens,
                            temperature=0.3,
                        ),
                        timeout=call_timeout,
                    )
                    if response.usage:
                        self._total_tokens += response.usage.total_tokens
                    if not response.choices:
                        raise ProviderError(f"OpenRouter empty response after retry ({model})")
                    return response.choices[0].message.content or ""
                except asyncio.TimeoutError:
                    raise ProviderError(f"OpenRouter timeout after retry ({model})")
                except ProviderError:
                    raise
                except Exception:
                    if is_rate_limit:
                        raise ProviderRateLimitError(f"OpenRouter rate limited: {e}")
                    raise ProviderError(f"OpenRouter server error after retry ({model}): {e}")
            raise ProviderError(f"OpenRouter error ({model}): {e}")

    async def _call_with_fallback(
        self, primary: str, fallbacks: list[str] | None, messages: list[dict],
        max_tokens: int = 4096, is_vision: bool = False, cancel_check=None,
        timeout: int | None = None,
    ) -> str:
        """Try primary model, then each fallback in order.

        For the "free" preset, appends openrouter/free as the final
        fallback.  For paid presets (efficient/balanced/premium/custom),
        openrouter/free is NOT appended because the free routing
        endpoint may not work with the user's API key (commonly returns
        401 "User not found" for accounts that don't have free-tier
        access, masking the real error from the primary model).

        When a timeout is specified, the primary gets 40% and the
        remaining budget is split equally across fallback models.
        """
        # Build deduplicated model chain: primary → fallbacks
        chain = [primary]
        for fb in (fallbacks or []):
            if fb not in chain:
                chain.append(fb)
        # Only append openrouter/free for the free preset — paid presets
        # should not fall back to free routing which often fails with 401.
        if self._preset_name == "free" and "openrouter/free" not in chain:
            chain.append("openrouter/free")

        # Distribute timeout: primary gets 40%, rest is split among fallbacks
        if timeout and len(chain) > 1:
            primary_timeout = int(timeout * 0.4)
            fb_count = len(chain) - 1
            fb_timeout = max(30, (timeout - primary_timeout) // fb_count)
        else:
            primary_timeout = timeout
            fb_timeout = timeout

        errors: list[tuple[str, ProviderError]] = []
        for i, model in enumerate(chain):
            model_timeout = primary_timeout if i == 0 else fb_timeout
            try:
                return await self._call_cancellable(
                    model, messages, max_tokens, cancel_check, timeout=model_timeout,
                )
            except ProviderError as e:
                errors.append((model, e))
                logger.warning(
                    "OpenRouter model %s failed (%d/%d): %s",
                    model, i + 1, len(chain), e,
                )
                continue
        # Report ALL errors (not just the last one) so the user can see
        # which primary model failed and why, rather than only seeing the
        # final fallback error which may be misleading (e.g. 401 on
        # openrouter/free masking a rate-limit on the primary model).
        if errors:
            error_details = "; ".join(f"{m}: {e}" for m, e in errors)
            raise ProviderError(f"All OpenRouter models failed — {error_details}")
        raise ProviderError("All OpenRouter models failed (no models in chain)")

    async def _call_cancellable(
        self, model: str, messages: list[dict], max_tokens: int = 4096,
        cancel_check=None, timeout: int | None = None,
    ) -> str:
        """Wrap _call with cancellation polling so we can abort mid-API-call."""
        if not cancel_check:
            return await self._call(model, messages, max_tokens, timeout=timeout)
        task = asyncio.ensure_future(self._call(model, messages, max_tokens, timeout=timeout))
        try:
            while not task.done():
                await asyncio.sleep(1.0)
                if not task.done():
                    cancel_check()  # raises CancelledError if cancelled
            return task.result()
        except BaseException:
            task.cancel()
            raise

    # ── Vision Analysis ────────────────────────────────────────────────

    async def analyze_frames(
        self, frames: list[FrameData], custom_prompt: Optional[str] = None,
        cancel_check=None, progress_callback=None,
    ) -> list[SceneDescription]:
        instruction = custom_prompt if custom_prompt else DEFAULT_FRAME_ANALYSIS_PROMPT
        batch_size = 8
        total = len(frames)
        num_batches = (total + batch_size - 1) // batch_size
        # Store results per batch index to maintain ordering
        batch_results: list[list[SceneDescription]] = [[] for _ in range(num_batches)]
        frames_completed = 0
        # Process up to 2 batches concurrently — the rate limiter still enforces
        # RPM/interval limits, but this allows the next API call to be queued
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
                            "type": "image_url",
                            "image_url": {"url": f"data:image/jpeg;base64,{frame.base64}"},
                        })
                        content.append({
                            "type": "text",
                            "text": f"[Frame at {frame.timestamp:.1f}s]",
                        })

                messages = [{"role": "user", "content": content}]
                try:
                    raw = await self._call_with_fallback(
                        self._vision_model, self._vision_fallbacks, messages,
                        is_vision=True, cancel_check=cancel_check,
                    )
                except (ProviderError, ProviderRateLimitError) as api_err:
                    # Single batch failure: use fallback descriptions instead of
                    # crashing the entire analysis and losing all other batches.
                    logger.warning(
                        "Batch %d/%d failed (frames %d-%d), using fallback descriptions: %s",
                        batch_idx + 1, num_batches, start, start + len(batch) - 1, api_err,
                    )
                    for frame in batch:
                        batch_results[batch_idx].append(SceneDescription(
                            timestamp=frame.timestamp,
                            description="Frame analysis unavailable",
                            importance_score=5,
                            thumbnail_path=frame.path,
                            subject_x=50,
                        ))
                    frames_completed += len(batch)
                    if progress_callback:
                        await progress_callback(min(frames_completed, total), total)
                    return
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
                                "Batch %d frame %d: AI response missing subject_x field, defaulting to 50",
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
                    logger.warning(f"Failed to parse frame analysis: {e}")
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

    # ── Summary Generation ─────────────────────────────────────────────

    async def generate_summary(
        self,
        transcript: list[TranscriptSegment],
        scenes: list[SceneDescription],
        cancel_check=None,
    ) -> VideoSummary:
        # Dynamic context budget based on model
        context_budget = self._get_context_budget(self._summary_model)
        overhead = 500  # instructions + JSON format
        content_budget = max(2000, context_budget - overhead)
        transcript_budget = int(content_budget * 0.7)
        scene_budget = int(content_budget * 0.3)

        transcript_text = self._condense_transcript(transcript, max_chars=transcript_budget)
        scene_text = self._condense_scenes(scenes, max_chars=scene_budget)

        logger.info(
            "Summary prompt budget for model '%s': %d chars (transcript=%d, scenes=%d)",
            self._summary_model, context_budget, transcript_budget, scene_budget,
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
        raw = await self._call_with_fallback(
            self._summary_model, self._summary_fallbacks, messages, cancel_check=cancel_check,
        )
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

    # ── Viral Clip Detection ───────────────────────────────────────────

    # Timeout for clip detection calls — longer than regular calls because
    # the model needs to process a full transcript + scene list and
    # generate structured JSON for multiple clips.
    # Scaled by preset: free models are slower but get less data, paid models
    # are faster and get more data.
    _CLIP_TIMEOUT_BY_PRESET = {
        "free": 240,       # 4 min — shorter because prompt is smaller
        "efficient": 240,  # 4 min
        "balanced": 300,   # 5 min
        "premium": 300,    # 5 min
    }
    _DEFAULT_CLIP_TIMEOUT = 300

    @staticmethod
    def _condense_transcript(transcript: list[TranscriptSegment], max_chars: int = 12000) -> str:
        """Build a compact transcript representation that fits within max_chars.

        Merges consecutive segments from the same speaker and truncates
        if the total text exceeds the limit.
        """
        if not transcript:
            return "(no transcript)"

        # Merge consecutive segments from the same speaker for compactness
        merged: list[tuple[float, float, str, str]] = []
        for seg in transcript:
            if merged and merged[-1][3] == seg.speaker:
                # Extend the previous segment
                prev = merged[-1]
                merged[-1] = (prev[0], seg.end, prev[2] + " " + seg.text, seg.speaker)
            else:
                merged.append((seg.start, seg.end, seg.text, seg.speaker))

        lines = []
        total = 0
        for start, end, text, speaker in merged:
            line = f"[{start:.0f}-{end:.0f}] {speaker}: {text}"
            total += len(line) + 1
            if total > max_chars:
                lines.append(f"[{start:.0f}-{end:.0f}] {speaker}: {text[:100]}...")
                lines.append(f"... (transcript truncated at {max_chars} chars)")
                break
            lines.append(line)
        return "\n".join(lines)

    @staticmethod
    def _condense_scenes(scenes: list[SceneDescription], max_chars: int = 4000) -> str:
        """Build a compact scene description that fits within max_chars.

        Prioritizes high-importance scenes and truncates descriptions.
        """
        if not scenes:
            return "(no scene descriptions)"

        # Sort by importance so high-scoring scenes come first
        sorted_scenes = sorted(scenes, key=lambda s: s.importance_score, reverse=True)
        lines = []
        total = 0
        for s in sorted_scenes:
            desc = s.description[:120] if len(s.description) > 120 else s.description
            line = f"[{s.timestamp:.0f}s] ({s.importance_score}/10) {desc}"
            total += len(line) + 1
            if total > max_chars:
                remaining = len(sorted_scenes) - len(lines)
                lines.append(f"... ({remaining} more scenes omitted)")
                break
            lines.append(line)

        # Re-sort by timestamp for chronological order
        lines.sort()
        return "\n".join(lines)

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

        # Scale prompt size to the model's context window.
        # The system prompt + JSON schema + instructions take ~2000 chars,
        # so the remaining budget goes to transcript + scenes + hot moments.
        context_budget = self._get_context_budget(self._text_model)
        # Account for video summary in overhead if present
        summary_overhead = len(video_summary) + 50 if video_summary else 0
        overhead = 2500 + summary_overhead  # system prompt + JSON format + instructions + summary
        content_budget = max(3000, context_budget - overhead)
        # Allocate: 65% transcript, 25% scenes, 10% hot moments
        transcript_budget = int(content_budget * 0.65)
        scene_budget = int(content_budget * 0.25)
        hot_budget = int(content_budget * 0.10)

        logger.info(
            "Clip detection context budget for model '%s': %d chars "
            "(transcript=%d, scenes=%d, hot=%d, summary=%d)",
            self._text_model, context_budget,
            transcript_budget, scene_budget, hot_budget, summary_overhead,
        )

        transcript_text = self._condense_transcript(transcript, max_chars=transcript_budget)
        scene_text = self._condense_scenes(scenes, max_chars=scene_budget)

        # Highlight the high-importance scenes for the model
        hot_scenes = [s for s in scenes if s.importance_score >= 7]
        hot_text = ""
        if hot_scenes:
            hot_text = "\n\nHIGH-IMPACT VISUAL MOMENTS (prioritize clips containing these):\n"
            hot_lines = []
            for s in hot_scenes[:15]:  # Cap at 15 hot scenes
                desc_limit = min(100, hot_budget // max(len(hot_scenes[:15]), 1))
                desc = s.description[:desc_limit] if len(s.description) > desc_limit else s.description
                hot_lines.append(f"  * [{s.timestamp:.0f}s] score={s.importance_score}/10 — {desc}")
            hot_text += "\n".join(hot_lines)
            if len(hot_text) > hot_budget:
                hot_text = hot_text[:hot_budget]

        # Use user-specified duration range or defaults
        dur_min = int(min_duration) if min_duration else 30
        dur_max = int(max_duration) if max_duration else 300
        dur_min_fmt = f"{dur_min // 60}:{dur_min % 60:02d}"
        dur_max_fmt = f"{dur_max // 60}:{dur_max % 60:02d}"
        num_clips = clip_count or settings.MAX_CLIP_CANDIDATES

        system_prompt = (
            instruction + "\n\n"
            "STRICT REQUIREMENTS:\n"
            f"- Each clip duration MUST be between {dur_min} and {dur_max} seconds ({dur_min_fmt} to {dur_max_fmt})\n"
            "- Natural start point — never mid-sentence or mid-thought\n"
            "- Natural end point — conclusion, punchline, or resolution\n"
            "- Must work standalone without context from the full video\n"
            "- The main subject/speaker MUST remain in focus for the entire clip\n"
            "- Do NOT combine scenes from different settings or unrelated topics into one clip\n\n"
            "Return ONLY valid JSON, no other text:\n"
            '{"clips": [{"id": 1, "title": "Hook-driven title under 60 chars", '
            '"start_time": 45.2, "end_time": 112.8, "duration": 67.6, '
            '"viral_score": 87, "viral_score_reasoning": "Strong hook...", '
            '"clip_type": "informative|funny|emotional|shocking|tutorial|highlight|debate|reveal", '
            '"platform": "tiktok|youtube_shorts|both", '
            '"suggested_caption": "Caption with #hashtags", '
            '"hook_text": "Text overlay for opening frame", '
            '"why_this_works": "One sentence explanation"}], '
            '"total_candidates": 8, "best_clip_id": 1}'
        )
        summary_section = ""
        if video_summary:
            summary_section = f"VIDEO SUMMARY:\n{video_summary}\n\n"
        user_prompt = (
            f"Video duration: {video_duration:.1f} seconds\n\n"
            f"{summary_section}"
            f"TRANSCRIPT:\n{transcript_text}\n\n"
            f"SCENE DESCRIPTIONS:\n{scene_text}"
            f"{hot_text}\n\n"
            f"You MUST return exactly {num_clips} viral clip candidates, ranked by viral potential from highest to lowest. "
            f"Do NOT return fewer than {num_clips} clips — find {num_clips} distinct moments even if some score lower. "
            f"Prioritize the most share-worthy, attention-grabbing, emotionally impactful moments. "
            f"Each clip must be between {dur_min} and {dur_max} seconds long. "
            "Prioritize clips that contain visually striking moments alongside strong dialogue."
        )

        prompt_size = len(system_prompt) + len(user_prompt)
        logger.info(
            "Clip detection prompt size: %d chars (transcript=%d, scenes=%d, hot=%d)",
            prompt_size, len(transcript_text), len(scene_text), len(hot_text),
        )

        for attempt in range(3):
            if cancel_check:
                cancel_check()

            # Build fresh messages each attempt — do NOT accumulate conversation
            # history, as it bloats the prompt and causes timeouts
            messages = [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ]

            raw = await self._call_with_fallback(
                self._text_model, self._text_fallbacks, messages,
                max_tokens=8192, cancel_check=cancel_check,
                timeout=self._CLIP_TIMEOUT_BY_PRESET.get(self._preset_name, self._DEFAULT_CLIP_TIMEOUT),
            )
            try:
                raw = raw.strip()
                if raw.startswith("```"):
                    raw = raw.split("\n", 1)[1].rsplit("```", 1)[0]
                data = json.loads(raw)
                clips_data = data.get("clips", [])
                if not clips_data:
                    logger.warning(f"Attempt {attempt + 1}: Model returned empty clips array, raw={raw[:300]}")
                    continue
                clips = []
                filtered_reasons = []
                for c in clips_data:
                    try:
                        start = float(c.get("start_time", 0))
                        end = float(c.get("end_time", 0))
                        # Always compute from timestamps — model's duration field is unreliable
                        duration = end - start
                        if duration <= 0:
                            # Fallback to model's duration field
                            duration = float(c.get("duration", 0))
                        clip_title = c.get("title", "Untitled")
                        if duration < 15:
                            filtered_reasons.append(
                                f"  #{c.get('id', '?')} '{clip_title}': too short ({duration:.1f}s)")
                            continue
                        if duration > 600:
                            filtered_reasons.append(
                                f"  #{c.get('id', '?')} '{clip_title}': too long ({duration:.1f}s)")
                            continue
                        clips.append(ClipCandidate(
                            id=int(c.get("id", len(clips) + 1)),
                            title=clip_title,
                            start_time=start,
                            end_time=end,
                            duration=round(duration, 1),
                            viral_score=max(1, min(100, int(float(c.get("viral_score", 50))))),
                            viral_score_reasoning=str(c.get("viral_score_reasoning", "")),
                            clip_type=str(c.get("clip_type", "highlight")),
                            platform=str(c.get("platform", "both")),
                            suggested_caption=str(c.get("suggested_caption", "")),
                            hook_text=str(c.get("hook_text", "")),
                            why_this_works=str(c.get("why_this_works", "")),
                        ))
                    except (TypeError, ValueError, KeyError) as clip_err:
                        logger.warning(f"Skipping malformed clip: {clip_err} — data: {c}")
                        continue

                if filtered_reasons:
                    logger.info(
                        f"Filtered {len(filtered_reasons)} clips by duration:\n"
                        + "\n".join(filtered_reasons)
                    )

                if clips:
                    logger.info(f"Parsed {len(clips)} valid clips from {len(clips_data)} candidates")
                    return clips

                # All clips filtered out — log and retry
                logger.warning(
                    f"Attempt {attempt + 1}: {len(clips_data)} clips returned but all "
                    f"filtered out. Retrying..."
                )
                continue

            except json.JSONDecodeError as e:
                logger.warning(
                    f"Attempt {attempt + 1}: Invalid JSON from model: {e}\n"
                    f"Raw response (first 500 chars): {raw[:500]}"
                )
                continue
            except Exception as e:
                logger.warning(
                    f"Attempt {attempt + 1}: Unexpected error parsing clips: {type(e).__name__}: {e}\n"
                    f"Raw response (first 500 chars): {raw[:500]}"
                )
                continue
        raise ProviderError("Failed to parse viral clips after 3 attempts")

    async def generate_seo(
        self, clip_title: str, clip_transcript: str, video_summary: str,
        platform: str, cancel_check=None,
    ) -> ClipSEO:
        # Detect description-generation override: the enriched summary starts
        # with a marker so we can skip the default SEO prompt (whose short
        # character limits conflict with description generation).
        is_description = video_summary.startswith("DESCRIPTION_OVERRIDE")

        # Cap data to fit model context
        context_budget = self._get_context_budget(self._text_model)
        if is_description:
            # Description override: video_summary IS the prompt, give it
            # the majority of the budget; transcript supplements it.
            overhead = 200  # metadata only, no DEFAULT_SEO_PROMPT
            data_budget = max(1000, context_budget - overhead)
            summary_budget = min(len(video_summary), int(data_budget * 0.6))
            transcript_cap = data_budget - summary_budget
        else:
            overhead = len(DEFAULT_SEO_PROMPT) + 200
            data_budget = max(1000, context_budget - overhead)
            summary_budget = min(len(video_summary), int(data_budget * 0.4))
            transcript_cap = data_budget - summary_budget
        capped_summary = video_summary[:summary_budget] if len(video_summary) > summary_budget else video_summary
        capped_transcript = clip_transcript[:transcript_cap] if len(clip_transcript) > transcript_cap else clip_transcript

        if is_description:
            prompt = (
                f"{capped_summary}\n\n"
                f"CLIP TITLE: {clip_title}\n"
                f"TARGET PLATFORM: {platform}\n\n"
                f"CLIP TRANSCRIPT:\n{capped_transcript}\n"
            )
        else:
            prompt = (
                f"{DEFAULT_SEO_PROMPT}\n\n"
                f"CLIP TITLE: {clip_title}\n"
                f"TARGET PLATFORM: {platform}\n\n"
                f"VIDEO SUMMARY:\n{capped_summary}\n\n"
                f"CLIP TRANSCRIPT:\n{capped_transcript}\n"
            )
        messages = [{"role": "user", "content": prompt}]
        # Description generation needs more tokens — thinking-mode models
        # (e.g. Qwen 3.5) spend many tokens on internal reasoning, leaving
        # too few for the actual description at the default 4096 limit.
        tokens = 16384 if is_description else 4096
        raw = await self._call_with_fallback(
            self._text_model, self._text_fallbacks, messages,
            max_tokens=tokens, cancel_check=cancel_check,
        )
        try:
            data = normalize_seo_data(extract_json(raw))
            return ClipSEO(**data)
        except Exception:
            logger.warning(f"Failed to parse SEO JSON, using fallback. Raw (first 300): {raw[:300]}")
            return ClipSEO(
                title=clip_title,
                description=raw[:300] if raw else "SEO generation failed",
                tags=[], platform_tips="",
            )
