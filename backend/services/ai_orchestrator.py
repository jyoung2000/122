import asyncio
import logging
import time
from typing import Optional

from backend.config import settings
from backend.models import (
    FrameData, SceneDescription, TranscriptSegment, VideoSummary, ClipCandidate, ClipSEO,
)
from backend.services.providers.base import (
    AIProvider, ProviderError, ProviderRateLimitError, AllProvidersFailedError,
)
from backend.services.providers.openrouter_provider import OpenRouterProvider
from backend.services.providers.anthropic_provider import AnthropicProvider
from backend.services.providers.gemini_provider import GeminiProvider
from backend.services.providers.groq_provider import GroqProvider
from backend.services.providers.ollama_provider import OllamaProvider

logger = logging.getLogger(__name__)

# WebSocket broadcast callback type
WsBroadcastCallback = Optional[object]  # Will be a callable


class _CircuitBreaker:
    """Marks a provider degraded for 15 min after 3 failures in 10 min."""

    def __init__(self):
        self._failures: dict[str, list[float]] = {}
        self._degraded_until: dict[str, float] = {}

    def is_degraded(self, name: str) -> bool:
        if name in self._degraded_until:
            if time.monotonic() < self._degraded_until[name]:
                return True
            del self._degraded_until[name]
        return False

    def record_failure(self, name: str):
        now = time.monotonic()
        if name not in self._failures:
            self._failures[name] = []
        self._failures[name] = [t for t in self._failures[name] if now - t < 600]
        self._failures[name].append(now)
        failure_count = len(self._failures[name])
        logger.info("Circuit breaker: %s failure %d/3 in 10-min window", name, failure_count)
        if failure_count >= 3:
            self._degraded_until[name] = now + 900  # 15 min
            logger.warning("Circuit breaker: provider %s marked DEGRADED for 15 minutes", name)

    def record_success(self, name: str):
        was_degraded = name in self._degraded_until
        self._failures.pop(name, None)
        self._degraded_until.pop(name, None)
        if was_degraded:
            logger.info("Circuit breaker: provider %s RECOVERED (success after degraded)", name)

    def clear_degraded(self, name: str):
        """Immediately remove degraded status for a provider."""
        was_degraded = name in self._degraded_until
        self._degraded_until.pop(name, None)
        if was_degraded:
            logger.info("Circuit breaker: %s manually un-degraded before critical operation", name)

    def force_reset_all(self):
        """Reset ALL provider states. Used before critical pipeline stages."""
        had_degraded = list(self._degraded_until.keys())
        self._failures.clear()
        self._degraded_until.clear()
        if had_degraded:
            logger.info("Circuit breaker: RESET all states (was degraded: %s)", had_degraded)


def _build_provider(name: str) -> Optional[AIProvider]:
    try:
        if name == "openrouter" and settings.OPENROUTER_API_KEY:
            return OpenRouterProvider()
        elif name == "anthropic" and settings.ANTHROPIC_API_KEY:
            return AnthropicProvider()
        elif name == "gemini" and settings.GEMINI_API_KEY:
            return GeminiProvider()
        elif name == "groq" and settings.GROQ_API_KEY:
            return GroqProvider()
        elif name == "ollama":
            return OllamaProvider()
    except Exception as e:
        logger.warning(f"Failed to initialize provider {name}: {e}")
    return None


class AIOrchestrator:
    """
    Tries providers in fallback chain order.
    Circuit breaker: marks provider degraded for 15 min after 3 failures in 10 min.
    """

    def __init__(self, ws_broadcast=None, custom_prompts=None, cancel_check=None):
        self._circuit_breaker = _CircuitBreaker()
        self._ws_broadcast = ws_broadcast
        self._custom_prompts = custom_prompts  # PromptSet or None
        self._cancel_check = cancel_check  # callable that raises on cancel
        self._providers: dict[str, AIProvider] = {}
        for name in settings.active_provider_chain:
            p = _build_provider(name)
            if p:
                self._providers[name] = p

    # Rough cost per 1K tokens by provider (input+output blended average)
    _COST_PER_1K_TOKENS = {
        "openrouter": 0.0002,   # varies by model; free tier = 0
        "anthropic": 0.006,     # Claude Sonnet ~$3/$15 per M tokens blended
        "gemini": 0.0003,       # Gemini Flash is very cheap
        "groq": 0.0001,         # Groq is very cheap
        "ollama": 0.0,          # local, no cost
    }

    def get_total_tokens(self) -> int:
        """Return total tokens used across all provider instances."""
        return sum(p.total_tokens for p in self._providers.values())

    def estimate_cost(self) -> float:
        """Estimate total cost in USD from all provider token usage."""
        total = 0.0
        for name, provider in self._providers.items():
            tokens = provider.total_tokens
            if tokens > 0:
                rate = self._COST_PER_1K_TOKENS.get(name, 0.001)
                total += (tokens / 1000) * rate
        return round(total, 6)

    def reset_circuit_breaker(self):
        """Reset circuit breaker state before critical pipeline operations.

        Call this before summary generation and clip detection to ensure
        that failures from non-critical steps (transcript correction)
        don't block the core analysis pipeline.
        """
        self._circuit_breaker.force_reset_all()

    def get_text_model_info(self) -> dict:
        """Return info about the text model that will handle the next text_completion call.

        Used by transcript correction to:
        1. Log which model is polishing the transcript
        2. Set an appropriate timeout based on model type (thinking vs standard)
        """
        chain = self._get_active_chain()
        if not chain:
            return {"provider": "none", "model": "none", "is_thinking": False}
        provider = chain[0]
        return {
            "provider": provider.provider_name,
            "model": provider.text_model_name,
            "is_thinking": provider.is_thinking_model,
        }

    def _get_active_chain(self) -> list[AIProvider]:
        chain = []
        skipped = []
        for name in settings.active_provider_chain:
            if name in self._providers and not self._circuit_breaker.is_degraded(name):
                chain.append(self._providers[name])
            elif name in self._providers:
                skipped.append(name)
        chain_names = [p.provider_name for p in chain]
        if skipped:
            logger.info("Active provider chain: %s (degraded: %s)", chain_names, skipped)
        else:
            logger.debug("Active provider chain: %s", chain_names)
        return chain

    async def _notify_attempt(self, job_id: str, provider_name: str, task: str):
        logger.info(f"Attempting {task} via {provider_name}")
        if self._ws_broadcast:
            try:
                await self._ws_broadcast(job_id, {
                    "type": "status",
                    "message": f"Attempting {task} via {provider_name}...",
                })
            except Exception:
                pass

    async def _notify_fallback(self, job_id: str, from_provider: str, reason: str):
        logger.info(f"Falling back from {from_provider}: {reason}")
        if self._ws_broadcast:
            try:
                await self._ws_broadcast(job_id, {
                    "type": "fallback",
                    "from_provider": from_provider,
                    "to_provider": "next",
                    "reason": reason,
                })
            except Exception:
                pass

    async def analyze_frames(
        self, frames: list[FrameData], job_id: str,
        progress_callback=None,
    ) -> tuple[list[SceneDescription], str]:
        """Returns (results, provider_name_used).
        progress_callback(frames_done, total_frames, provider_name) is called per batch."""
        frame_prompt = self._custom_prompts.frame_analysis if self._custom_prompts else None
        # Append subject tracking instructions when enabled
        if settings.SUBJECT_TRACKING_ENABLED:
            st_prompt = (self._custom_prompts.subject_tracking if self._custom_prompts else None) or ""
            if st_prompt:
                base = frame_prompt or ""
                frame_prompt = f"{base}\n\n4. Subject position — {st_prompt}" if base else st_prompt
        for provider in self._get_active_chain():
            if not provider.supports_vision:
                continue
            try:
                await self._notify_attempt(job_id, provider.provider_name, f"scene analysis ({len(frames)} frames)")

                async def _provider_progress(done, total):
                    if progress_callback:
                        await progress_callback(done, total, provider.provider_name)

                t0 = time.monotonic()
                result = await provider.analyze_frames(
                    frames, custom_prompt=frame_prompt,
                    cancel_check=self._cancel_check,
                    progress_callback=_provider_progress,
                )
                elapsed = time.monotonic() - t0
                logger.info("Scene analysis via %s completed in %.1fs (%d scenes)", provider.provider_name, elapsed, len(result))
                # Log subject tracking distribution for debugging
                if result:
                    sx_values = [s.subject_x for s in result]
                    sx_unique = len(set(sx_values))
                    all_default = all(v == 50 for v in sx_values)
                    logger.info(
                        "Subject tracking via %s: %d scenes, %d unique subject_x values, range [%d, %d], mean=%.1f%s",
                        provider.provider_name, len(sx_values), sx_unique,
                        min(sx_values), max(sx_values),
                        sum(sx_values) / len(sx_values),
                        " ⚠ ALL VALUES ARE 50 — model may not have detected subject positions" if all_default else "",
                    )
                self._circuit_breaker.record_success(provider.provider_name)
                return result, provider.provider_name
            except (ProviderRateLimitError, ProviderError) as e:
                self._circuit_breaker.record_failure(provider.provider_name)
                await self._notify_fallback(job_id, provider.provider_name, str(e))
                continue
        raise AllProvidersFailedError("All vision providers failed")

    async def generate_summary(
        self,
        transcript: list[TranscriptSegment],
        scenes: list[SceneDescription],
        job_id: str,
    ) -> tuple[VideoSummary, str]:
        """Returns (summary, provider_name_used)."""
        summary_prompt = self._custom_prompts.summary if self._custom_prompts else None
        for provider in self._get_active_chain():
            try:
                await self._notify_attempt(job_id, provider.provider_name, "summary generation")
                t0 = time.monotonic()
                result = await provider.generate_summary(transcript, scenes, cancel_check=self._cancel_check, custom_prompt=summary_prompt)
                elapsed = time.monotonic() - t0
                logger.info("Summary generation via %s completed in %.1fs", provider.provider_name, elapsed)
                self._circuit_breaker.record_success(provider.provider_name)
                return result, provider.provider_name
            except (ProviderRateLimitError, ProviderError) as e:
                self._circuit_breaker.record_failure(provider.provider_name)
                await self._notify_fallback(job_id, provider.provider_name, str(e))
                continue
        raise AllProvidersFailedError("All providers failed for summary generation")

    async def detect_viral_clips(
        self,
        transcript: list[TranscriptSegment],
        scenes: list[SceneDescription],
        video_duration: float,
        job_id: str,
        clip_count: Optional[int] = None,
        min_duration: Optional[float] = None,
        max_duration: Optional[float] = None,
        clip_focus: Optional[str] = None,
        video_summary: Optional[str] = None,
        existing_clips: Optional[str] = None,
        hot_zones=None,
        progress_callback=None,
    ) -> tuple[list[ClipCandidate], str]:
        """Returns (clips, provider_name_used)."""
        clip_prompt = self._custom_prompts.viral_clip_detection if self._custom_prompts else None
        # If clip_focus is provided, build an augmented focus prompt that
        # BUILDS ON the viral detection infrastructure rather than replacing it
        if clip_focus and clip_focus.strip():
            focus_text = clip_focus.strip()
            clip_prompt = (
                f"You are finding clips in a video that focus on a specific user-requested topic.\n\n"
                f"USER'S FOCUS QUERY: \"{focus_text}\"\n\n"
                f"SEMANTIC EXPANSION — Before searching, expand this query into related concepts:\n"
                f"Think about synonyms, related terms, sub-topics, and adjacent concepts that someone "
                f"searching for \"{focus_text}\" would also want to see. For example, if the focus is "
                f"'fighting', also look for: combat, battle, argument, confrontation, sparring, conflict, "
                f"physical altercation, self-defense, martial arts, etc.\n\n"
                f"RELEVANCE TIERS:\n"
                f"  Tier 1 (STRONG — score 80-100): The segment IS ABOUT '{focus_text}'. "
                f"The topic is the main subject of discussion or the primary visual action.\n"
                f"  Tier 2 (MODERATE — score 50-79): The segment discusses '{focus_text}' as a "
                f"significant part of a broader conversation. Multiple sentences or visual moments relate to it.\n"
                f"  Tier 3 (WEAK — score 20-49): The topic is mentioned briefly or tangentially. "
                f"Only include Tier 3 clips if fewer than 3 Tier 1/2 clips exist.\n"
                f"  EXCLUDE: Segments that merely mention a word related to '{focus_text}' in passing, "
                f"negations ('I don't like {focus_text}'), or purely metaphorical usage.\n\n"
                f"COMPOUND QUERIES: If the focus contains both a topic and a mood/quality "
                f"(e.g., 'funny cooking moments'), prioritize segments matching BOTH aspects. "
                f"Score clips higher when they combine the topic with the specified mood.\n\n"
                f"SCORING: Use 'viral_score' to represent RELEVANCE to '{focus_text}' (not virality). "
                f"A clip with 90 relevance means the segment is deeply, directly about the focus topic. "
                f"In 'viral_score_reasoning', explain WHY this clip matches the focus query and which "
                f"relevance tier it falls into.\n\n"
                f"Additionally include 'focus_relevance' (1-100) and 'focus_tier' (\"strong\", \"moderate\", "
                f"or \"weak\") in each clip's JSON.\n\n"
                f"SCENE & SUBJECT COHERENCE (CRITICAL):\n"
                f"- The main subject or speaker MUST stay in focus throughout the entire clip\n"
                f"- NEVER cut across unrelated scenes or topics — the clip must feel like ONE moment\n"
                f"- If a clip covers a conversation, keep it within the same exchange between the same speakers\n"
                f"- The visual setting should remain consistent — don't span across location changes\n"
                f"- Prefer segments where the camera stays on the main action without jarring cuts\n"
                f"- If scene descriptions show different settings at different timestamps, do NOT combine them into one clip\n\n"
                f"BOUNDARY RULES:\n"
                f"- Start at natural speech boundaries — beginning of a sentence, after a pause, at a speaker change\n"
                f"- End at natural conclusions — even if focus content extends further, find a clean exit point\n"
                f"- Must work standalone without context from the full video\n"
                f"- Prefer clips where the focus topic is introduced within the first 5 seconds"
            )
            logger.info("Clip focus mode active for job %s: '%s'", job_id, focus_text)
        # Per-provider timeout prevents any single provider from blocking the
        # fallback chain.  Cloud APIs get 5 min for clip detection (large
        # prompts with full transcript + scenes need time); local ollama
        # gets 2 min (3 retries × ~30s each with 90s httpx timeout as cap).
        _PROVIDER_TIMEOUT = {"ollama": 120}
        _DEFAULT_PROVIDER_TIMEOUT = 330  # 5.5 min — allows 300s internal + overhead

        for provider in self._get_active_chain():
            pname = provider.provider_name
            timeout = _PROVIDER_TIMEOUT.get(pname, _DEFAULT_PROVIDER_TIMEOUT)
            try:
                await self._notify_attempt(job_id, pname, "viral clip detection")
                t0 = time.monotonic()
                result = await asyncio.wait_for(
                    provider.detect_viral_clips(
                        transcript, scenes, video_duration,
                        custom_prompt=clip_prompt, cancel_check=self._cancel_check,
                        clip_count=clip_count, min_duration=min_duration,
                        max_duration=max_duration,
                        video_summary=video_summary,
                        existing_clips=existing_clips,
                        hot_zones=hot_zones,
                        progress_callback=progress_callback,
                    ),
                    timeout=timeout,
                )
                elapsed = time.monotonic() - t0
                logger.info("Clip detection via %s completed in %.1fs (%d clips)", pname, elapsed, len(result))
                self._circuit_breaker.record_success(pname)
                return result, pname
            except asyncio.TimeoutError:
                logger.warning("Clip detection via %s timed out after %ds", pname, timeout)
                self._circuit_breaker.record_failure(pname)
                await self._notify_fallback(job_id, pname, f"Timed out after {timeout}s")
                continue
            except (ProviderRateLimitError, ProviderError) as e:
                self._circuit_breaker.record_failure(pname)
                await self._notify_fallback(job_id, pname, str(e))
                continue
        raise AllProvidersFailedError("All providers failed for viral clip detection")

    async def text_completion(self, prompt: str, max_tokens: int = 4096, timeout: float = 60, job_id: str = "", skip_circuit_breaker: bool = False) -> str:
        """Generic text completion using the configured provider chain.

        Used by transcript correction, translation, and other text-only tasks.
        Falls back through the provider chain on failure.
        Returns the raw text response from the first successful provider.

        Args:
            skip_circuit_breaker: If True, failures are NOT recorded in the
                circuit breaker. Use this for non-critical/optional operations
                (like transcript polishing) that should not degrade the provider
                for subsequent critical operations (summary, clip detection).
        """
        for provider in self._get_active_chain():
            pname = provider.provider_name
            model_name = provider.text_model_name
            try:
                logger.info("text_completion attempting via %s model=%s (%d chars prompt)", pname, model_name, len(prompt))
                t0 = time.monotonic()
                result = await asyncio.wait_for(
                    provider.text_complete(prompt, max_tokens=max_tokens, timeout=int(timeout)),
                    timeout=timeout,
                )
                elapsed = time.monotonic() - t0
                logger.info("text_completion via %s model=%s completed in %.1fs", pname, model_name, elapsed)
                if not skip_circuit_breaker:
                    self._circuit_breaker.record_success(pname)
                return result
            except asyncio.TimeoutError:
                if not skip_circuit_breaker:
                    self._circuit_breaker.record_failure(pname)
                logger.warning("text_completion via %s model=%s timed out after %.0fs — trying next provider", pname, model_name, timeout)
                await self._notify_fallback(job_id, pname, f"Text completion timed out after {timeout:.0f}s (model={model_name})")
                continue
            except Exception as e:
                if not skip_circuit_breaker:
                    self._circuit_breaker.record_failure(pname)
                logger.warning("text_completion via %s model=%s failed: %s — trying next provider", pname, model_name, e)
                await self._notify_fallback(job_id, pname, str(e))
                continue
        raise AllProvidersFailedError("All providers failed for text completion")

    async def generate_seo(
        self,
        clip_title: str,
        clip_transcript: str,
        video_summary: str,
        platform: str,
        job_id: str,
    ) -> tuple[ClipSEO, str]:
        """Returns (seo, provider_name_used)."""
        seo_prompt = self._custom_prompts.seo if self._custom_prompts else None
        for provider in self._get_active_chain():
            try:
                await self._notify_attempt(job_id, provider.provider_name, "SEO generation")
                t0 = time.monotonic()
                result = await provider.generate_seo(
                    clip_title, clip_transcript, video_summary,
                    platform, cancel_check=self._cancel_check,
                    custom_prompt=seo_prompt,
                )
                elapsed = time.monotonic() - t0
                logger.info("SEO generation via %s completed in %.1fs", provider.provider_name, elapsed)
                self._circuit_breaker.record_success(provider.provider_name)
                return result, provider.provider_name
            except (ProviderRateLimitError, ProviderError) as e:
                self._circuit_breaker.record_failure(provider.provider_name)
                await self._notify_fallback(job_id, provider.provider_name, str(e))
                continue
        raise AllProvidersFailedError("All providers failed for SEO generation")
