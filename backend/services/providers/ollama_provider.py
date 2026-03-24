import asyncio
import json
import logging
import re
from typing import Optional

import httpx

from backend.config import settings
from backend.models import (
    FrameData, SceneDescription, TranscriptSegment, VideoSummary, ClipCandidate, ClipSEO,
)
from backend.services.providers.base import AIProvider, ChunkedClipDetectionMixin, ProviderError, extract_json, extract_partial_clips, extract_description_fallback, normalize_seo_data, build_fallback_summary, has_real_summary_content, build_summary_from_transcript
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

# ── Dynamic timeout & speed measurement ─────────────────────────────
_measured_speeds: dict[str, dict] = {}  # model_name -> {"eval_tok_s": float, "gen_tok_s": float, "samples": int}

# Hot zones set by pipeline before calling analyze_frames (for frame triage)
_current_hot_zones: list = []


def compute_dynamic_timeout(
    prompt_chars: int,
    max_tokens: int,
    provider_name: str,
    model_name: str = "",
    is_vision: bool = False,
) -> float:
    """Calculate timeout based on actual measured hardware speed."""
    DEFAULT_SPEEDS = {
        "ollama": {"eval_tok_s": 400, "gen_tok_s": 12},
        "openrouter": {"eval_tok_s": 50000, "gen_tok_s": 200},
        "gemini": {"eval_tok_s": 50000, "gen_tok_s": 200},
        "groq": {"eval_tok_s": 100000, "gen_tok_s": 800},
        "anthropic": {"eval_tok_s": 50000, "gen_tok_s": 150},
    }

    if model_name and model_name in _measured_speeds:
        speeds = _measured_speeds[model_name]
    else:
        speeds = DEFAULT_SPEEDS.get(provider_name, DEFAULT_SPEEDS["ollama"])

    prompt_tokens = prompt_chars // 4
    eval_time = prompt_tokens / speeds["eval_tok_s"]
    gen_time = max_tokens / speeds["gen_tok_s"]

    buffer = 30.0 if provider_name == "ollama" else 10.0
    timeout = (eval_time + gen_time) * 1.2 + buffer

    if is_vision:
        timeout *= 4

    return max(60.0, timeout)


def record_speed_measurement(model_name: str, prompt_tokens: int, eval_tokens: int, elapsed: float):
    """Record actual inference speed for future timeout calculations."""
    if elapsed <= 0 or eval_tokens <= 0:
        return

    gen_tok_s = eval_tokens / elapsed
    eval_tok_s = prompt_tokens / max(0.1, elapsed * 0.15)

    if model_name not in _measured_speeds:
        _measured_speeds[model_name] = {"eval_tok_s": eval_tok_s, "gen_tok_s": gen_tok_s, "samples": 1}
    else:
        existing = _measured_speeds[model_name]
        n = existing["samples"]
        alpha = min(0.3, 1.0 / (n + 1))
        existing["eval_tok_s"] = existing["eval_tok_s"] * (1 - alpha) + eval_tok_s * alpha
        existing["gen_tok_s"] = existing["gen_tok_s"] * (1 - alpha) + gen_tok_s * alpha
        existing["samples"] = n + 1

    logger.debug(
        "Speed measurement for %s: gen=%.1f tok/s, eval=%.1f tok/s (sample %d)",
        model_name, gen_tok_s, eval_tok_s,
        _measured_speeds[model_name]["samples"],
    )


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


class OllamaProvider(ChunkedClipDetectionMixin, AIProvider):
    """Local Ollama provider - always available as final fallback."""

    def __init__(self):
        self._host = settings.OLLAMA_HOST
        self._vision_model = settings.OLLAMA_VISION_MODEL
        self._text_model = settings.OLLAMA_TEXT_MODEL
        self._summary_model = self._text_model
        self._total_tokens = 0
        self._model_ctx: dict[str, int] = {}
        self._capabilities_detected = False
        # Shared connection pool — reused across all API calls.
        # Default timeout set high (10 min) because local inference on CPU
        # can be extremely slow (llava:7b on CPU = 3-5 min per vision frame).
        # Per-request timeouts in _call_vision and _call_text override this
        # for their specific needs.
        self._client = httpx.AsyncClient(
            timeout=httpx.Timeout(600.0, connect=15.0),
            limits=httpx.Limits(max_connections=4, max_keepalive_connections=2),
        )
        # Track whether we need CPU-only mode due to VRAM constraints
        self._force_cpu: bool = False
        self._vram_checked: bool = False
        self._available_vram_mb: int = 0

    async def close(self):
        """Close the shared HTTP client. Call when provider is no longer needed."""
        await self._client.aclose()

    async def unload_models(self):
        """Unload all models from VRAM so other processes (Whisper) can use the GPU."""
        for model in (self._vision_model, self._text_model):
            try:
                await self._client.post(f"{self._host}/api/generate", json={
                    "model": model,
                    "keep_alive": 0,
                })
                logger.info("Unloaded Ollama model from VRAM: %s", model)
            except Exception as e:
                logger.debug("Failed to unload Ollama model %s: %s", model, e)

    async def _detect_vram(self) -> int:
        """Detect available GPU VRAM in MB via nvidia-smi.

        Returns available VRAM in MB, or 0 if detection fails.
        Caches the result since VRAM doesn't change mid-run.
        """
        if self._vram_checked:
            return self._available_vram_mb

        self._vram_checked = True

        # Method 1: Ask Ollama for GPU info via /api/ps
        try:
            resp = await self._client.get(f"{self._host}/api/ps", timeout=5.0)
            if resp.status_code == 200:
                pass  # Ollama /api/ps doesn't directly report free VRAM
        except Exception:
            pass

        # Method 2: Use nvidia-smi from the app container (if available)
        try:
            import subprocess
            result = subprocess.run(
                ["nvidia-smi", "--query-gpu=memory.free", "--format=csv,noheader,nounits"],
                capture_output=True, text=True, timeout=5,
            )
            if result.returncode == 0 and result.stdout.strip():
                free_mb = int(result.stdout.strip().split('\n')[0])
                self._available_vram_mb = free_mb
                logger.info("Detected %d MB free VRAM via nvidia-smi", free_mb)
                return free_mb
        except Exception:
            pass

        return self._available_vram_mb

    def _get_num_gpu(self, model_name: str) -> int:
        """Determine how many layers to offload to GPU.

        Returns 0 for CPU-only (when VRAM is insufficient),
        or -1 for auto (let Ollama decide, works when VRAM is ample).

        On a 4GB GTX 1650:
        - llava:7b (3.83 GiB + 595 MiB CLIP projector) -> NEVER fits -> num_gpu=0
        - llama3.1:8b (4.33 GiB model) -> NEVER fits fully -> num_gpu=0
        - moondream:1.8b (~1 GiB) -> fits with ~2.5GB free -> num_gpu=-1
        - qwen2.5:3b (~1.8 GiB) -> fits with ~1.5GB free -> num_gpu=-1
        """
        if self._force_cpu:
            return 0

        # Models known to exceed 4GB VRAM — always force CPU
        model_lower = model_name.lower()
        large_models = ["llava:7b", "llava:13b", "llama3", "llama3.1:8b", "mistral:7b",
                        "gemma:7b", "deepseek:7b", "phi3:14b", "qwen2.5:7b"]
        for pattern in large_models:
            if pattern in model_lower:
                logger.info("Model %s known to exceed 4GB VRAM — forcing num_gpu=0 (CPU)", model_name)
                return 0

        # Small models that fit in 4GB VRAM
        small_models = ["moondream", "qwen2.5:3b", "qwen2.5:1.5b", "qwen2.5:0.5b",
                        "phi3:mini", "gemma:2b", "tinyllama", "llava:v1.6-mistral-7b"]
        for pattern in small_models:
            if pattern in model_lower:
                return -1  # Let Ollama auto-decide

        # Unknown model — check available VRAM
        if self._available_vram_mb > 0 and self._available_vram_mb < 2000:
            logger.info(
                "Only %d MB VRAM available — forcing num_gpu=0 for unknown model %s",
                self._available_vram_mb, model_name,
            )
            return 0

        # Default: let Ollama try GPU, and we'll catch OOM in the retry logic
        return -1

    def _is_oom_error(self, error_text: str) -> bool:
        """Check if an error response indicates CUDA out-of-memory."""
        oom_patterns = [
            "out of memory",
            "cudaMalloc failed",
            "GGML_ASSERT(buffer) failed",
            "failed to allocate CUDA",
            "CUDA error",
            "SIGABRT",
            "SIGSEGV",
        ]
        error_lower = error_text.lower() if error_text else ""
        return any(p.lower() in error_lower for p in oom_patterns)

    async def _unload_model(self, model_name: str):
        """Unload a model from Ollama to free VRAM/RAM before loading another.

        Critical on 4GB GPUs where only one model can be resident at a time.
        Uses keep_alive=0 which tells Ollama to immediately unload the model.
        """
        try:
            await self._client.post(
                f"{self._host}/api/generate",
                json={"model": model_name, "keep_alive": 0},
                timeout=10.0,
            )
            logger.debug("Unloaded Ollama model: %s", model_name)
        except Exception as e:
            logger.debug("Failed to unload model %s (non-critical): %s", model_name, e)

    async def _ensure_capabilities(self):
        """Lazy-detect model capabilities on first use."""
        if not self._capabilities_detected:
            await self._detect_capabilities()
            self._capabilities_detected = True

    async def _ensure_model_active(self, model_name: str):
        """Ensure a specific model is loaded, unloading the other if needed.

        On 4GB VRAM GPUs, only one model can be resident at a time.
        Explicitly unloading before loading prevents OOM crashes.
        """
        other_model = self._text_model if model_name == self._vision_model else self._vision_model
        if other_model == model_name:
            return
        try:
            await self._client.post(f"{self._host}/api/generate", json={
                "model": other_model,
                "keep_alive": 0,
            }, timeout=10.0)
            logger.debug("VRAM swap: unloaded %s before loading %s", other_model, model_name)
        except Exception:
            pass

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
        """Pre-load models with VRAM-aware offloading to avoid cold start OOM.

        On 4GB GPUs, this is where we detect that large models need CPU-only
        mode, BEFORE the first real analysis call can crash.
        """
        # Detect available VRAM first
        await self._detect_vram()

        # Warn if user-selected models are too large for available VRAM
        if self._available_vram_mb > 0 and self._available_vram_mb <= 4500:
            large_vision = ["llava:7b", "llava:13b", "llava-v1.6"]
            large_text = ["llama3.1:8b", "llama3:8b", "mistral:7b", "gemma:7b",
                         "deepseek:7b", "qwen2.5:7b"]
            vision_lower = self._vision_model.lower()
            text_lower = self._text_model.lower()
            for pattern in large_vision:
                if pattern in vision_lower:
                    logger.warning(
                        "VRAM WARNING: Vision model '%s' (~4GB) exceeds %dMB VRAM — "
                        "will run on CPU (very slow). Recommend: moondream:1.8b (~1GB)",
                        self._vision_model, self._available_vram_mb,
                    )
                    break
            for pattern in large_text:
                if pattern in text_lower:
                    logger.warning(
                        "VRAM WARNING: Text model '%s' (~4GB) exceeds %dMB VRAM — "
                        "will run on CPU (slow). Recommend: qwen2.5:3b-instruct (~1.8GB)",
                        self._text_model, self._available_vram_mb,
                    )
                    break

        vision_num_gpu = self._get_num_gpu(self._vision_model)
        text_num_gpu = self._get_num_gpu(self._text_model)

        logger.info(
            "Ollama warmup: vision=%s (num_gpu=%s), text=%s (num_gpu=%s), force_cpu=%s",
            self._vision_model, vision_num_gpu,
            self._text_model, text_num_gpu,
            self._force_cpu,
        )

        try:
            # Warm up vision model
            options = {"num_predict": 1}
            if vision_num_gpu >= 0:
                options["num_gpu"] = vision_num_gpu
            resp = await self._client.post(f"{self._host}/api/chat", json={
                "model": self._vision_model,
                "messages": [{"role": "user", "content": "test"}],
                "stream": False,
                "options": options,
            }, timeout=120.0)
            if resp.status_code == 500 and self._is_oom_error(resp.text[:500]):
                logger.warning(
                    "Vision model %s OOM during warmup — forcing CPU-only for all models",
                    self._vision_model,
                )
                self._force_cpu = True
                # Retry with CPU
                options["num_gpu"] = 0
                await asyncio.sleep(3)
                await self._client.post(f"{self._host}/api/chat", json={
                    "model": self._vision_model,
                    "messages": [{"role": "user", "content": "test"}],
                    "stream": False,
                    "options": options,
                }, timeout=120.0)
        except Exception as e:
            error_str = str(e)
            if self._is_oom_error(error_str):
                logger.warning("Vision model OOM during warmup — forcing CPU-only: %s", error_str[:150])
                self._force_cpu = True
            else:
                logger.warning("Ollama vision warmup failed (non-fatal): %s", e)

        try:
            # Warm up text model (unload vision first to free VRAM)
            try:
                await self._client.post(f"{self._host}/api/generate", json={
                    "model": self._vision_model,
                    "keep_alive": 0,
                }, timeout=10.0)
            except Exception:
                pass

            options = {"num_predict": 1}
            if text_num_gpu >= 0:
                options["num_gpu"] = text_num_gpu
            if self._force_cpu:
                options["num_gpu"] = 0
            resp = await self._client.post(f"{self._host}/api/chat", json={
                "model": self._text_model,
                "messages": [{"role": "user", "content": "test"}],
                "stream": False,
                "options": options,
            }, timeout=120.0)
            if resp.status_code == 500 and self._is_oom_error(resp.text[:500]):
                logger.warning("Text model %s OOM during warmup — forcing CPU-only", self._text_model)
                self._force_cpu = True
        except Exception as e:
            error_str = str(e)
            if self._is_oom_error(error_str):
                logger.warning("Text model OOM during warmup — forcing CPU-only: %s", error_str[:150])
                self._force_cpu = True
            else:
                logger.warning("Ollama text warmup failed (non-fatal): %s", e)

        mode = "CPU-only (num_gpu=0)" if self._force_cpu else "GPU-assisted"
        logger.info(
            "Ollama models warmed up: vision=%s, text=%s, mode=%s",
            self._vision_model, self._text_model, mode,
        )

    def _get_effective_ctx(self, model_name: str) -> int:
        """Return context length safe for available VRAM.

        On GTX 1650 (4GB), VRAM is the bottleneck:
        - KV cache at 4096 context for an 8B model = ~512 MiB
        - KV cache at 2048 context for an 8B model = ~256 MiB

        When running in CPU-only mode (num_gpu=0), context can be larger
        since KV cache goes to system RAM. But we still cap it to avoid
        excessive prompt sizes that slow generation.
        """
        if self._force_cpu:
            # CPU mode — system RAM is plentiful, can use larger context
            # But still cap to avoid extremely slow generation
            model_lower = model_name.lower()
            if "llava" in model_lower or "vision" in model_lower or "moondream" in model_lower:
                return 4096  # Needs room for image embedding + full response
            elif any(s in model_lower for s in ["3b", "1b", "0.5b"]):
                return 8192
            elif any(s in model_lower for s in ["7b", "8b"]):
                return 4096
            return 4096

        # GPU mode — VRAM is the bottleneck
        detected = self._model_ctx.get(model_name, 0)
        if detected > 0:
            return min(detected, 4096)  # Hard cap at 4096 for GPU mode

        model_lower = model_name.lower()
        if "llava" in model_lower or "vision" in model_lower or "moondream" in model_lower:
            return 4096  # Moondream needs room for image tokens + response
        elif any(s in model_lower for s in ["3b", "1b", "0.5b"]):
            return 4096
        elif any(s in model_lower for s in ["7b", "8b"]):
            return 2048  # Reduced from 4096 to save VRAM
        return 2048

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
        """Send ONE frame to the vision model with VRAM-aware GPU offloading.

        On 4GB GPUs, the CLIP vision encoder (595 MiB for llava:7b) often
        causes cudaMalloc OOM. We detect this and retry with num_gpu=0
        (CPU-only) to avoid crashing the Ollama runner process.
        """
        await self._ensure_capabilities()
        vision_timeout = 360.0  # 6 minutes — enough for CPU inference

        num_gpu = self._get_num_gpu(self._vision_model)

        for attempt in range(2):  # At most 2 attempts: GPU then CPU
            try:
                options = {
                    "num_ctx": self._get_effective_ctx(self._vision_model),
                }
                if num_gpu >= 0:
                    options["num_gpu"] = num_gpu
                # On second attempt (after OOM), always force CPU
                if attempt == 1:
                    options["num_gpu"] = 0
                    logger.info("Retrying vision call with num_gpu=0 (CPU-only) after OOM")

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
                        "options": options,
                    },
                    timeout=vision_timeout,
                )

                # Check for OOM in error response
                if response.status_code == 500:
                    error_text = response.text[:500]
                    if self._is_oom_error(error_text) and attempt == 0:
                        logger.warning(
                            "Ollama vision OOM on attempt %d (model=%s) — "
                            "retrying with CPU-only. Error: %s",
                            attempt + 1, self._vision_model, error_text[:200],
                        )
                        self._force_cpu = True
                        # Brief pause for Ollama to recover from the crash
                        await asyncio.sleep(3)
                        continue
                    # Non-OOM 500 or second attempt 500 — raise
                    response.raise_for_status()

                response.raise_for_status()
                data = response.json()
                self._total_tokens += data.get("prompt_eval_count", 0) + data.get("eval_count", 0)
                return data.get("message", {}).get("content", "")

            except httpx.TimeoutException:
                raise ProviderError(
                    f"Ollama vision timeout after {vision_timeout}s "
                    f"(model={self._vision_model}) — consider using a smaller model"
                )
            except httpx.HTTPStatusError as e:
                error_text = e.response.text[:500] if e.response else ""
                if self._is_oom_error(error_text) and attempt == 0:
                    logger.warning(
                        "Ollama vision HTTP error with OOM pattern — retrying CPU-only: %s",
                        error_text[:200],
                    )
                    self._force_cpu = True
                    await asyncio.sleep(3)
                    continue
                raise ProviderError(f"Ollama vision error: {e}")
            except Exception as e:
                error_str = str(e)
                if self._is_oom_error(error_str) and attempt == 0:
                    logger.warning("Ollama vision OOM — retrying CPU-only: %s", error_str[:200])
                    self._force_cpu = True
                    await asyncio.sleep(3)
                    continue
                raise ProviderError(f"Ollama vision error: {e}")

        raise ProviderError(f"Ollama vision failed after 2 attempts (model={self._vision_model})")

    async def _call_text(self, prompt: str, system: str = "", max_tokens: int = 4096,
                         timeout: float = 90.0, json_mode: bool = False,
                         generation_progress=None) -> str:
        """Text completion with streaming to prevent HTTP timeout death spiral.

        Instead of waiting for the full response (which can take 5+ minutes on
        slow hardware), we stream token-by-token. The HTTP connection stays alive
        as long as chunks keep arriving, eliminating false timeouts entirely.
        """
        await self._ensure_capabilities()

        messages = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": prompt})

        # Compute minimum viable timeout for local hardware
        prompt_tokens = (len(prompt) + len(system)) // 4
        eval_time = prompt_tokens / 500  # ~500 tok/s prompt eval on GTX 1650
        gen_time = max_tokens / 12       # ~12 tok/s generation
        min_timeout = eval_time + gen_time + 30
        effective_timeout = max(timeout, min_timeout)

        # Stall timeout: max seconds between chunks before we consider it stuck
        stall_timeout = max(60.0, effective_timeout * 0.3)

        num_gpu = self._get_num_gpu(self._text_model)

        payload = {
            "model": self._text_model,
            "messages": messages,
            "stream": True,
            "options": {
                "num_predict": max_tokens,
                "num_ctx": self._get_effective_ctx(self._text_model),
                "temperature": 0.5,  # Small models need more diversity to avoid repetitive descriptions
                "top_p": 0.9,        # Better variety in sampling
                "repeat_penalty": 1.15,  # Penalize repetitive phrasing
            },
        }
        # VRAM-aware GPU offloading
        if num_gpu >= 0:
            payload["options"]["num_gpu"] = num_gpu
        if json_mode:
            payload["format"] = "json"

        logger.debug(
            "Ollama _call_text (streaming): model=%s, prompt_len=%d, system_len=%d, "
            "effective_timeout=%.0fs, stall_timeout=%.0fs, num_gpu=%s",
            self._text_model, len(prompt), len(system), effective_timeout, stall_timeout, num_gpu,
        )

        for attempt in range(2):  # At most 2 attempts: GPU then CPU
            try:
                # On second attempt (after OOM), force CPU
                if attempt == 1:
                    payload["options"]["num_gpu"] = 0
                    logger.info("Retrying text call with num_gpu=0 (CPU-only) after OOM")

                collected_text = []
                total_prompt_tokens = 0
                total_eval_tokens = 0
                token_count = 0

                async with self._client.stream(
                    "POST",
                    f"{self._host}/api/chat",
                    json=payload,
                    timeout=httpx.Timeout(effective_timeout, connect=15.0, read=stall_timeout),
                ) as response:
                    # Check for OOM crash in Ollama's response
                    if response.status_code == 500:
                        error_text = (await response.aread()).decode("utf-8", errors="replace")[:500]
                        if self._is_oom_error(error_text) and attempt == 0:
                            logger.warning(
                                "Ollama text OOM (model=%s) — switching to CPU-only: %s",
                                self._text_model, error_text[:200],
                            )
                            self._force_cpu = True
                            await asyncio.sleep(3)
                            continue
                        raise httpx.HTTPStatusError(
                            f"Server error 500", request=response.request, response=response
                        )

                    response.raise_for_status()
                    async for line in response.aiter_lines():
                        if not line.strip():
                            continue
                        try:
                            chunk = json.loads(line)
                        except json.JSONDecodeError:
                            continue

                        msg = chunk.get("message", {})
                        content = msg.get("content", "")
                        if content:
                            collected_text.append(content)
                            token_count += 1

                            # Emit progress every ~200 tokens
                            if generation_progress and token_count % 200 == 0:
                                try:
                                    await generation_progress(token_count, max_tokens)
                                except Exception:
                                    pass

                        if chunk.get("done", False):
                            total_prompt_tokens = chunk.get("prompt_eval_count", 0)
                            total_eval_tokens = chunk.get("eval_count", 0)
                            break

                self._total_tokens += total_prompt_tokens + total_eval_tokens
                result = "".join(collected_text)

                if not result:
                    logger.warning("Ollama streaming returned empty response for model=%s", self._text_model)
                else:
                    logger.debug(
                        "Ollama streaming complete: %d chars, %d prompt_tokens, %d eval_tokens",
                        len(result), total_prompt_tokens, total_eval_tokens,
                    )

                    # Record speed measurement for dynamic timeout calculation
                    if total_eval_tokens > 0 and token_count > 0:
                        record_speed_measurement(
                            self._text_model, total_prompt_tokens, total_eval_tokens,
                            token_count / 12.0  # rough elapsed estimate
                        )

                return result

            except httpx.ReadTimeout:
                raise ProviderError(
                    f"Ollama text stalled (no data for {stall_timeout:.0f}s) — "
                    f"model={self._text_model}, the model may be overloaded"
                )
            except httpx.TimeoutException:
                raise ProviderError(f"Ollama text timeout after {effective_timeout:.0f}s (model={self._text_model})")
            except httpx.HTTPStatusError as e:
                error_text = e.response.text[:500] if e.response else ""
                if self._is_oom_error(error_text) and attempt == 0:
                    logger.warning(
                        "Ollama text HTTP error with OOM pattern — retrying CPU-only: %s",
                        error_text[:200],
                    )
                    self._force_cpu = True
                    await asyncio.sleep(3)
                    continue
                raise ProviderError(f"Ollama HTTP {e.response.status_code}: {e.response.text[:200]}")
            except Exception as e:
                error_str = str(e)
                if self._is_oom_error(error_str) and attempt == 0:
                    logger.warning("Ollama text OOM — retrying CPU-only: %s", error_str[:200])
                    self._force_cpu = True
                    await asyncio.sleep(3)
                    continue
                raise ProviderError(f"Ollama text error ({type(e).__name__}): {e}")

        raise ProviderError(f"Ollama text failed after 2 attempts (model={self._text_model})")

    async def text_complete(self, prompt: str, max_tokens: int = 4096, timeout: int | None = None) -> str:
        return await self._call_text(prompt, max_tokens=max_tokens)

    async def analyze_frames(
        self, frames: list[FrameData], custom_prompt: Optional[str] = None,
        cancel_check=None, progress_callback=None,
    ) -> list[SceneDescription]:
        total = len(frames)

        # ── Speed gate: test first frame, skip if impractically slow ──
        # On Sandy Bridge CPU with llava:7b, each frame takes 360s+ (timeout).
        # Detect this early and limit frames rather than wasting 30+ minutes.
        _speed_limited_indices = None
        if total > 10 and frames[0].base64:
            import time as _t
            await self._ensure_model_active(self._vision_model)
            t0 = _t.monotonic()
            try:
                # Use the ACTUAL prompt for speed testing (not a simplified version)
                # The real prompt is 3-4x longer and triggers different tokenization
                test_prompt = (
                    "Describe what you see in this video frame in 1-2 sentences. "
                    "Focus on: who/what is visible, the setting, any text on screen. "
                    "Be specific and factual — only describe what is ACTUALLY VISIBLE."
                    + _VISION_JSON_SUFFIX
                )
                test_result = await asyncio.wait_for(
                    self._call_vision(test_prompt, frames[0].base64),
                    timeout=120.0,
                )
                elapsed = _t.monotonic() - t0
                logger.info(
                    "Ollama vision speed test: %.1fs for 1 frame (model=%s)",
                    elapsed, self._vision_model,
                )

                if elapsed > 60:
                    # Impractically slow — cap to 20 evenly-spaced frames
                    max_frames = 20
                    logger.warning(
                        "Ollama vision too slow (%.0fs/frame) — reducing %d→%d frames "
                        "(est. %.0f min vs %.0f hours full set)",
                        elapsed, total, max_frames,
                        (max_frames * elapsed) / 60, (total * elapsed) / 3600,
                    )
                elif elapsed > 15:
                    # Moderate speed — cap to 80 frames (~7.5 min at 5.6s/frame)
                    max_frames = 80
                    logger.info(
                        "Ollama vision moderate speed (%.0fs/frame) — reducing %d→%d frames",
                        elapsed, total, max_frames,
                    )
                elif elapsed > 5 and total > 200:
                    # Normal speed but too many frames — cap to 150
                    # 150 frames × 5.6s ≈ 14 min (vs 29 min for 472)
                    max_frames = 150
                    logger.info(
                        "Vision OK (%.1fs/frame) but %d frames is excessive — reducing to %d",
                        elapsed, total, max_frames,
                    )
                else:
                    max_frames = None

                if max_frames is not None and total > max_frames:
                    step = max(1, total // max_frames)
                    keep = set()
                    for i in range(0, total, step):
                        keep.add(i)
                    keep.add(0)
                    keep.add(total - 1)
                    _speed_limited_indices = keep

            except asyncio.TimeoutError:
                logger.warning(
                    "Ollama vision speed test timed out (>120s, model=%s) — "
                    "generating timestamp-based descriptions instead. "
                    "Consider switching to moondream:1.8b for faster vision.",
                    self._vision_model,
                )
                scenes = []
                for i, frame in enumerate(frames):
                    mins = int(frame.timestamp // 60)
                    secs = int(frame.timestamp % 60)
                    scenes.append(SceneDescription(
                        timestamp=frame.timestamp,
                        description=f"Frame at {mins}:{secs:02d} (vision skipped — model too slow on CPU)",
                        importance_score=5,
                        thumbnail_path=frame.path,
                        subject_x=50,
                    ))
                    if progress_callback:
                        await progress_callback(i + 1, total)
                return scenes
            except Exception as e:
                logger.warning("Vision speed test failed (%s) — proceeding with all frames", e)

        await self._ensure_model_active(self._vision_model)
        # Use simplified prompt for small local models — they can't reason about
        # "social media potential" or "spectacle" but CAN describe what's visible
        if custom_prompt:
            instruction = custom_prompt
        else:
            instruction = (
                "Describe what you see in this video frame in 1-2 sentences. "
                "Focus on: who/what is visible, the setting, any text on screen. "
                "Be specific and factual — only describe what is ACTUALLY VISIBLE."
            )

        # Two-stage vision: fast scan to identify interesting frames, then detailed analysis
        interesting_indices = set(range(total))  # default: all frames
        consecutive_failures = 0
        MAX_CONSECUTIVE_FAILURES = 5  # bail out if Ollama fails this many times in a row

        # Hot-zone frame triage: skip expensive vision on cold-zone frames
        if total > 20 and _current_hot_zones:
            hot_frame_indices = {0, total - 1}
            # Structural frames: at least 20 evenly-spaced
            structural_step = max(1, total // 20)
            for i in range(0, total, structural_step):
                hot_frame_indices.add(i)
            # Top 60% of hot zones get frame analysis
            top_zones = sorted(_current_hot_zones, key=lambda z: z.composite_score, reverse=True)
            cutoff = max(1, int(len(top_zones) * 0.6))
            for zone in top_zones[:cutoff]:
                for fi, frame in enumerate(frames):
                    if zone.start - 5 <= frame.timestamp <= zone.end + 5:
                        hot_frame_indices.add(fi)
            # ALSO include frames that were extracted via scene detection (not just interval).
            # These frames exist because FFmpeg detected a visual change — they're worth analyzing
            # even if the transcript is quiet at that moment.
            if len(frames) > 1:
                avg_interval = (frames[-1].timestamp - frames[0].timestamp) / max(len(frames) - 1, 1)
                for fi in range(1, len(frames)):
                    gap = frames[fi].timestamp - frames[fi - 1].timestamp
                    # If gap is significantly shorter than average, it was triggered by scene change
                    if gap < avg_interval * 0.5:
                        hot_frame_indices.add(fi)
                        hot_frame_indices.add(fi - 1)

            cold_count = total - len(hot_frame_indices)
            if cold_count > 0:
                logger.info(
                    "Ollama frame triage: %d/%d frames in hot zones (skipping %d cold-zone frames)",
                    len(hot_frame_indices), total, cold_count,
                )
                interesting_indices = hot_frame_indices

        # Skip quick scan entirely for Ollama — small vision models (moondream,
        # llava:7b) compress their score range to 1-4 for most content, causing the
        # threshold filter to reject 99% of frames. The detailed analysis on all
        # frames is more reliable and avoids the 2x API call overhead.
        skip_quick_scan = True

        if skip_quick_scan:
            logger.info(
                "Ollama: skipping quick scan — %d frames to analyze",
                len(interesting_indices),
            )
        elif total > 10:
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
                    consecutive_failures = 0
                except Exception:
                    quick_scores.append(5)  # assume interesting on failure
                    consecutive_failures += 1
                    if consecutive_failures >= MAX_CONSECUTIVE_FAILURES:
                        logger.error(
                            "Ollama quick scan: %d consecutive failures — aborting scan, "
                            "treating remaining frames as interesting",
                            consecutive_failures,
                        )
                        # Fill remaining frames with default score
                        quick_scores.extend([5] * (total - len(quick_scores)))
                        break

            # Keep frames scoring at or above threshold, always include first and last
            interesting_indices = {0, total - 1}
            for i, score in enumerate(quick_scores):
                if score >= QUICK_SCAN_THRESHOLD:
                    interesting_indices.add(i)

            # Minimum scene guarantee: at least 1 scene per 5 minutes of video
            if frames:
                video_duration = frames[-1].timestamp - frames[0].timestamp
                min_scenes = max(10, int(video_duration / 300))
                original_count = len(interesting_indices)
                if len(interesting_indices) < min_scenes:
                    step = max(1, total // min_scenes)
                    for i in range(0, total, step):
                        interesting_indices.add(i)
                    logger.info(
                        "Ollama: quick scan only found %d interesting frames, "
                        "padded to %d with even sampling (min=%d for %.0f min video)",
                        original_count, len(interesting_indices),
                        min_scenes, video_duration / 60,
                    )

            skipped = total - len(interesting_indices)
            if skipped > 0:
                logger.info("Two-stage vision: skipping %d/%d low-interest frames (threshold=%d)",
                            skipped, total, QUICK_SCAN_THRESHOLD)

        # Stage 2: Full analysis with concurrency limiter

        # Apply speed-limited frame set if the speed gate detected slow inference
        if _speed_limited_indices is not None:
            interesting_indices = _speed_limited_indices
            logger.info("Using speed-limited frame set: %d of %d frames", len(interesting_indices), total)

        sem = asyncio.Semaphore(VISION_CONCURRENCY)
        scenes: list[Optional[SceneDescription]] = [None] * total
        completed = 0
        stage2_consecutive_failures = 0
        stage2_aborted = False

        # Track previous description for temporal context
        _prev_descriptions: list[str] = []  # last N descriptions for context
        _CONTEXT_WINDOW = 3  # number of previous descriptions to include

        async def _analyze_one(fi: int, frame: FrameData):
            nonlocal completed, stage2_consecutive_failures, stage2_aborted
            async with sem:
                if cancel_check:
                    cancel_check()
                if stage2_aborted or not frame.base64 or fi not in interesting_indices:
                    completed += 1
                    if progress_callback:
                        await progress_callback(completed, total)
                    return

                # Build temporal context from previous descriptions
                temporal_context = ""
                if _prev_descriptions:
                    recent = _prev_descriptions[-_CONTEXT_WINDOW:]
                    ctx_lines = []
                    for pd in recent:
                        ctx_lines.append(f"  - {pd[:120]}")
                    temporal_context = (
                        "\n\nPREVIOUS FRAMES (for temporal context — do NOT repeat these, "
                        "describe what is NEW or DIFFERENT in THIS frame):\n"
                        + "\n".join(ctx_lines) + "\n"
                    )

                # Simplified prompt for small vision models
                ollama_vision_prompt = (
                    "Describe what you see in this video frame in 1-2 sentences. "
                    "Focus on: who/what is visible, the setting, any text on screen, "
                    "and the overall mood. Be specific and factual — only describe "
                    "what is ACTUALLY VISIBLE, do not infer or imagine what might be happening."
                    f"{temporal_context}"
                )

                prompt = ollama_vision_prompt + _VISION_JSON_SUFFIX
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
                    # ── Quality validation ──
                    if description:
                        # Strip JSON fragments
                        if description.startswith('{') or description.startswith('['):
                            description = re.sub(r'[{}\[\]":]', ' ', description)
                            description = re.sub(r'\s+', ' ', description).strip()

                        # Strip markdown code fences
                        if description.startswith('```'):
                            description = description.split('\n', 1)[-1].rsplit('```', 1)[0].strip()

                        # Reject obviously bad descriptions
                        if len(description) < 5 or description.lower() in (
                            "analysis failed", "error", "none", "n/a", "null",
                            "analysis failed (local ai)",
                        ):
                            description = f"Frame at {frame.timestamp:.0f}s — visual content present but description unavailable"
                            importance = 5

                        # Truncate extremely long descriptions (hallucination indicator)
                        if len(description) > 500:
                            cut = description.rfind('. ', 0, 400)
                            if cut > 200:
                                description = description[:cut + 1]
                            else:
                                description = description[:400] + "..."

                    # Store description for temporal context (only real descriptions)
                    if description and len(description) > 10 and "failed" not in description.lower():
                        _prev_descriptions.append(description)
                        if len(_prev_descriptions) > _CONTEXT_WINDOW * 2:
                            _prev_descriptions[:] = _prev_descriptions[-_CONTEXT_WINDOW:]

                    scenes[fi] = SceneDescription(
                        timestamp=frame.timestamp,
                        description=description,
                        importance_score=importance,
                        thumbnail_path=frame.path,
                        subject_x=subject_x,
                    )
                    stage2_consecutive_failures = 0
                except Exception as e:
                    logger.warning(f"Ollama frame analysis failed for {frame.timestamp}s: {e}")
                    stage2_consecutive_failures += 1

                    # Exponential backoff before retry decisions
                    if stage2_consecutive_failures >= 3:
                        backoff_delay = min(10, stage2_consecutive_failures * 2)
                        logger.info(
                            "Ollama: %d consecutive failures, waiting %ds before continuing",
                            stage2_consecutive_failures, backoff_delay,
                        )
                        await asyncio.sleep(backoff_delay)

                    if stage2_consecutive_failures >= 10:  # Was 5 — more tolerance
                        logger.error(
                            "Ollama frame analysis: %d consecutive failures — aborting "
                            "remaining frames with interpolated descriptions",
                            stage2_consecutive_failures,
                        )
                        stage2_aborted = True
                    else:
                        # Use a placeholder that will be replaced by interpolation later
                        scenes[fi] = SceneDescription(
                            timestamp=frame.timestamp,
                            description=f"Frame at {frame.timestamp:.0f}s — analysis temporarily unavailable",
                            importance_score=5,
                            thumbnail_path=frame.path,
                            subject_x=50,
                        )
                completed += 1
                if progress_callback:
                    await progress_callback(completed, total)

        # Run with concurrency limiter (sequential when VISION_CONCURRENCY=1)
        await asyncio.gather(*[_analyze_one(i, f) for i, f in enumerate(frames)])

        # Fill in cold-zone frames with interpolated descriptions from nearest analyzed frames
        for fi, frame in enumerate(frames):
            if scenes[fi] is None and fi not in interesting_indices:
                # Find nearest analyzed frame before and after
                prev_desc = ""
                next_desc = ""
                for search_back in range(fi - 1, -1, -1):
                    if scenes[search_back] is not None and search_back in interesting_indices:
                        prev_desc = scenes[search_back].description
                        break
                for search_fwd in range(fi + 1, total):
                    if scenes[search_fwd] is not None and search_fwd in interesting_indices:
                        next_desc = scenes[search_fwd].description
                        break

                # Build interpolated description from neighbors
                if prev_desc and next_desc:
                    interp_desc = f"Continuation: {prev_desc[:150]}"
                elif prev_desc:
                    interp_desc = f"Continuation: {prev_desc[:150]}"
                elif next_desc:
                    interp_desc = f"Before: {next_desc[:150]}"
                else:
                    interp_desc = "No visual analysis available for this segment"

                # Interpolate importance from neighbors
                prev_imp = next((scenes[j].importance_score for j in range(fi - 1, -1, -1) if scenes[j]), 5)
                next_imp = next((scenes[j].importance_score for j in range(fi + 1, total) if scenes[j]), 5)
                interp_importance = max(2, (prev_imp + next_imp) // 2 - 1)

                # Interpolate subject_x from neighbors
                prev_sx = next((scenes[j].subject_x for j in range(fi - 1, -1, -1) if scenes[j]), 50)
                next_sx = next((scenes[j].subject_x for j in range(fi + 1, total) if scenes[j]), 50)
                interp_sx = (prev_sx + next_sx) // 2

                scenes[fi] = SceneDescription(
                    timestamp=frame.timestamp,
                    description=interp_desc,
                    importance_score=interp_importance,
                    thumbnail_path=frame.path,
                    subject_x=interp_sx,
                )

        return [s for s in scenes if s is not None]

    async def generate_summary(
        self,
        transcript: list[TranscriptSegment],
        scenes: list[SceneDescription],
        cancel_check=None,
        custom_prompt=None,
    ) -> VideoSummary:
        # Unload vision model before text-heavy summary generation
        await self._unload_model(self._vision_model)
        await self._ensure_model_active(self._text_model)
        instruction = custom_prompt if custom_prompt else DEFAULT_SUMMARY_PROMPT

        # Dynamic context budget based on effective context length
        ctx_tokens = self._get_effective_ctx(self._text_model)
        overhead_tokens = 400  # prompt template + JSON format
        output_reserve = min(800, ctx_tokens // 3)  # reserve 1/3 for output
        available_tokens = ctx_tokens - overhead_tokens - output_reserve
        content_budget = max(2000, available_tokens * 4)  # ~4 chars per token

        transcript_budget = int(content_budget * 0.7)
        scene_budget = int(content_budget * 0.3)

        logger.info(
            "Ollama summary budget: ctx=%d tokens, content=%d chars (transcript=%d, scenes=%d)",
            ctx_tokens, content_budget, transcript_budget, scene_budget,
        )

        # Use proportional condensation (samples evenly across video) instead of head-truncation
        transcript_text = self._condense_transcript_proportional(
            transcript, max_chars=transcript_budget,
        )

        # Condense scenes with importance weighting
        if scenes:
            # Sort by importance, take top scenes, then re-sort by timestamp
            real_scenes = [s for s in scenes if "skipped" not in s.description.lower()
                           and "continuation" not in s.description.lower()
                           and len(s.description) > 20]
            if real_scenes:
                sorted_scenes = sorted(real_scenes, key=lambda s: s.importance_score, reverse=True)
                top_scenes = sorted_scenes[:30]  # top 30 by importance
                top_scenes.sort(key=lambda s: s.timestamp)  # re-sort chronologically
                scene_text = "\n".join(
                    f"[{s.timestamp:.0f}s] (imp={s.importance_score}) {s.description[:100]}"
                    for s in top_scenes
                )
            else:
                scene_text = "\n".join(
                    f"[{s.timestamp:.0f}s] {s.description[:80]}" for s in scenes[:20]
                )
            scene_text = _truncate_at_boundary(scene_text, scene_budget)
        else:
            scene_text = "No scene descriptions available."

        prompt = (
            f"{instruction}\n\n"
            f"TRANSCRIPT:\n{transcript_text}\n\n"
            f"SCENES:\n{scene_text}\n\n"
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
        tier=None,
        _partial_results: Optional[list] = None,
    ) -> list[ClipCandidate]:
        # Unload vision model before text-heavy clip detection
        await self._unload_model(self._vision_model)
        await self._ensure_model_active(self._text_model)
        # For videos > 5 min, use multi-pass detection via mixin (sequential for VRAM safety)
        if video_duration > 300:
            logger.info("Ollama: video %.0fs (>5min) — using sequential multi-pass clip detection", video_duration)
            if tier:
                from backend.config import apply_ollama_overrides
                tier = apply_ollama_overrides(tier, is_ollama=True)
            # CPU-forced models are extremely slow (1-3 tok/s on Sandy Bridge).
            # Even 12 windows × 90s timeout = 18 min of mostly-wasted time.
            # Widen windows so fewer are needed to cover the video.
            if self._force_cpu and tier:
                from dataclasses import replace as _replace
                # Double window size → roughly halves window count
                tier = _replace(tier, window_duration=tier.window_duration * 2)
                logger.info(
                    "CPU-forced model — widened windows to %.0fs to reduce timeout waste",
                    tier.window_duration,
                )
            return await self._multi_pass_clip_detection(
                transcript, scenes, video_duration,
                tier=tier, sequential=True,
                custom_prompt=custom_prompt, cancel_check=cancel_check,
                clip_count=clip_count, min_duration=min_duration,
                max_duration=max_duration, video_summary=video_summary,
                existing_clips=existing_clips,
                hot_zones=hot_zones,
                progress_callback=progress_callback,
                _partial_results=_partial_results,
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
        **kwargs,
    ) -> list[ClipCandidate]:
        await self._ensure_model_active(self._text_model)
        instruction = custom_prompt if custom_prompt else DEFAULT_VIRAL_CLIP_PROMPT

        # Context-aware budget calculation based on detected model context
        ctx_tokens = self._get_effective_ctx(self._text_model)
        input_budget_tokens = int(ctx_tokens * 0.55)  # reserve 45% for output
        input_budget_chars = input_budget_tokens * 4
        overhead_chars = 2000  # system prompt + JSON schema
        content_budget = max(1500, input_budget_chars - overhead_chars)

        # Split: 60% transcript, 20% scenes, 10% enrichment, 10% summary
        transcript_budget = int(content_budget * 0.6)
        scene_budget = int(content_budget * 0.2)
        enrichment_budget = int(content_budget * 0.1)
        summary_budget = int(content_budget * 0.1)

        # Use hot-zone-first condensation when available for better AI attention allocation
        if hot_zones:
            transcript_text = self._condense_transcript_hot_zone_first(
                transcript, max_chars=transcript_budget, hot_zones=hot_zones,
            )
        else:
            transcript_text = self._condense_transcript_proportional(
                transcript, max_chars=transcript_budget, hot_zones=hot_zones,
            )

        # Filter out synthetic/interpolated/failed scene descriptions
        # that would mislead the clip detection AI
        real_scenes = [
            s for s in scenes
            if s.description
            and len(s.description) > 20
            and "analysis skipped" not in s.description.lower()
            and "analysis temporarily unavailable" not in s.description.lower()
            and "visual content present but description unavailable" not in s.description.lower()
            and not s.description.startswith("Frame at ")
        ] if scenes else []
        if not real_scenes and scenes:
            # If ALL scenes are synthetic, keep the originals but note it
            real_scenes = scenes
            sparse_scene_hint = (
                "\nNOTE: Scene visual descriptions are limited for this video. "
                "Base your clip selections primarily on the TRANSCRIPT content.\n"
            )

        scene_text = "\n".join(
            f"[{s.timestamp:.0f}s] {s.description[:80]}" for s in real_scenes
        ) if real_scenes else ""
        scene_text = _truncate_at_boundary(scene_text, scene_budget)

        dur_min = int(min_duration) if min_duration else 30
        dur_max = int(max_duration) if max_duration else 300
        num_clips = clip_count or settings.MAX_CLIP_CANDIDATES

        # Detect sparse scene data and adjust prompt accordingly
        scenes_per_minute = len(scenes) / max(1, video_duration / 60)
        sparse_scene_hint = ""
        if scenes_per_minute < 0.5:
            logger.warning(
                "Scene data is sparse (%.1f scenes/min) — clip detection will rely primarily on transcript",
                scenes_per_minute,
            )
            sparse_scene_hint = (
                "\nNOTE: Scene/visual data is limited for this video. "
                "Prioritize transcript signals (dialogue energy, speaker dynamics, "
                "emotional peaks, topic changes) over visual correlation.\n"
            )

        system = (
            instruction + "\n"
            f"Each clip MUST be {dur_min}-{dur_max} seconds long.\n"
            "The main subject/speaker MUST stay in focus for the entire clip.\n"
            "Do NOT combine different scenes or unrelated topics into one clip.\n"
            f"{sparse_scene_hint}"
            "Return ONLY valid JSON."
        )

        # Enrich prompt with energy analysis — budget-aware
        enrichment = ""
        energy_text = analyze_transcript_energy(transcript, max_moments=15)
        correlation_text = correlate_scenes_with_transcript(transcript, scenes)
        guidance_text = derive_content_guidance(video_summary or "")

        enrich_used = 0
        if energy_text and enrich_used < enrichment_budget:
            chunk = _truncate_at_boundary(energy_text, min(800, enrichment_budget - enrich_used))
            enrichment += f"\nENERGY MAP (high-engagement moments):\n{chunk}\n"
            enrich_used += len(chunk)
        if correlation_text and enrich_used < enrichment_budget:
            chunk = _truncate_at_boundary(correlation_text, min(500, enrichment_budget - enrich_used))
            enrichment += f"\nAUDIO-VISUAL CORRELATION:\n{chunk}\n"
            enrich_used += len(chunk)
        if guidance_text and enrich_used < enrichment_budget:
            chunk = _truncate_at_boundary(guidance_text, min(300, enrichment_budget - enrich_used))
            enrichment += f"\nCONTENT GUIDANCE:\n{chunk}\n"

        # Inject hot zone data if available
        if hot_zones:
            hz_text = format_hot_zones_for_prompt(hot_zones)
            if hz_text:
                enrichment += f"\n{_truncate_at_boundary(hz_text, 600)}\n"

        # Summary-aware clip detection
        summary_section = ""
        if video_summary:
            vs = video_summary[:summary_budget] if len(video_summary) > summary_budget else video_summary
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
            # Progress callback for streaming visibility
            async def _gen_progress(tokens_done, tokens_total):
                if progress_callback:
                    try:
                        pct = min(95, int((tokens_done / max(tokens_total, 1)) * 100))
                        await progress_callback("generating", {"tokens": tokens_done, "pct": pct})
                    except Exception:
                        pass

            # Use longer timeout for clip detection — local models are slow
            raw = await self._call_text(
                prompt, system=system, max_tokens=4096, timeout=110.0,
                json_mode=True, generation_progress=_gen_progress,
            )
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
                # Try to salvage clips from partial/truncated JSON before retrying
                partial_clips_data = extract_partial_clips(raw)
                if partial_clips_data:
                    salvaged = []
                    for c in partial_clips_data:
                        try:
                            st = float(c.get("start_time", 0))
                            et = float(c.get("end_time", 0))
                            duration = et - st if et > st else float(c.get("duration", 0))
                            if 15 <= duration <= 600:
                                salvaged.append(ClipCandidate(
                                    id=c.get("id", len(salvaged) + 1),
                                    title=c.get("title", "Untitled"),
                                    start_time=st, end_time=et,
                                    duration=round(duration, 1),
                                    viral_score=max(1, min(100, int(float(c.get("viral_score", 50))))),
                                    viral_score_reasoning=str(c.get("viral_score_reasoning", "")),
                                    clip_type=str(c.get("clip_type", "highlight")),
                                    platform=str(c.get("platform", "both")),
                                    suggested_caption=str(c.get("suggested_caption", "")),
                                    hook_text=str(c.get("hook_text", "")),
                                    why_this_works=str(c.get("why_this_works", "")),
                                ))
                        except (KeyError, ValueError):
                            continue
                    if salvaged:
                        logger.warning(
                            "Attempt %d: Salvaged %d clips from partial JSON response",
                            attempt + 1, len(salvaged),
                        )
                        return salvaged

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

    # _windowed_clip_detection and _deduplicate_clips inherited from ChunkedClipDetectionMixin

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
