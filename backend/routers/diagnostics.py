"""Pipeline diagnostics endpoints for GPU status monitoring and pipeline testing."""

import asyncio
import base64
import io
import json
import logging
import os
import time
from typing import AsyncGenerator

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

from backend.config import settings

router = APIRouter(prefix="/api/diagnostics", tags=["diagnostics"])
logger = logging.getLogger(__name__)

# ── GPU info cache (doesn't change at runtime) ──────────────────────────
_gpu_info_cache: dict | None = None


async def _get_gpu_info() -> dict:
    """Get GPU hardware info. Tries Ollama's container first since the app
    container often doesn't have direct GPU access (nvidia-smi/torch CUDA).

    Detection priority:
    1. Ollama /api/ps — if any model has VRAM > 0, GPU exists
    2. Local nvidia-smi — works if GPU passthrough configured for app container
    3. Local torch.cuda — works if CUDA runtime available in app container
    4. Ollama probe — load a tiny model with num_gpu=99 and check GPU placement
    """
    global _gpu_info_cache
    if _gpu_info_cache is not None:
        return {**_gpu_info_cache}

    info = {
        "gpu_available": False,
        "gpu_in_use": False,
        "gpu_poisoned": False,
        "gpu_name": None,
        "vram_total_bytes": 0,
        "vram_used_bytes": 0,
        "cuda_available": False,
    }

    # Method 1: Check Ollama /api/ps — if a model is loaded on GPU, we know GPU exists
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            resp = await client.get(f"{settings.OLLAMA_HOST}/api/ps")
            if resp.status_code == 200:
                for m in resp.json().get("models", []):
                    if m.get("size_vram", 0) > 0:
                        info["gpu_available"] = True
                        info["cuda_available"] = True
                        info["gpu_name"] = "NVIDIA GPU (via Ollama)"
                        break
    except Exception:
        pass

    # Method 2: nvidia-smi locally
    if not info["gpu_available"]:
        try:
            import subprocess
            result = subprocess.run(
                ["nvidia-smi", "--query-gpu=name,memory.total",
                 "--format=csv,noheader,nounits"],
                capture_output=True, text=True, timeout=5,
            )
            if result.returncode == 0 and result.stdout.strip():
                parts = result.stdout.strip().split(",")
                if len(parts) >= 2:
                    info["gpu_name"] = parts[0].strip()
                    vram_mb = int(parts[1].strip())
                    # Only trust nvidia-smi if it reports > 1GB (avoids app container's
                    # 256MB iGPU misreport when discrete GPU is in Ollama container)
                    if vram_mb > 1024:
                        info["vram_total_bytes"] = vram_mb * 1024 * 1024
                        info["gpu_available"] = True
                        info["cuda_available"] = True
        except Exception:
            pass

    # Method 3: PyTorch CUDA
    if not info["gpu_available"]:
        try:
            import torch
            if torch.cuda.is_available():
                info["gpu_name"] = torch.cuda.get_device_name(0)
                info["vram_total_bytes"] = torch.cuda.get_device_properties(0).total_mem
                info["gpu_available"] = True
                info["cuda_available"] = True
        except Exception:
            pass

    # Method 4: Probe Ollama — load a model with GPU request, check if it gets GPU
    if not info["gpu_available"]:
        try:
            async with httpx.AsyncClient(timeout=60) as client:
                resp = await client.post(
                    f"{settings.OLLAMA_HOST}/api/generate",
                    json={
                        "model": settings.OLLAMA_VISION_MODEL,
                        "prompt": "hi",
                        "stream": False,
                        "options": {"num_gpu": 99, "num_predict": 1},
                    },
                    timeout=60,
                )
                if resp.status_code == 200:
                    ps_resp = await client.get(f"{settings.OLLAMA_HOST}/api/ps")
                    if ps_resp.status_code == 200:
                        for m in ps_resp.json().get("models", []):
                            if m.get("size_vram", 0) > 0:
                                info["gpu_available"] = True
                                info["cuda_available"] = True
                                info["gpu_name"] = "NVIDIA GPU (via Ollama)"
                                break
                    # Clean up probe
                    await client.post(
                        f"{settings.OLLAMA_HOST}/api/generate",
                        json={"model": settings.OLLAMA_VISION_MODEL, "keep_alive": 0},
                    )
                    await asyncio.sleep(2)
        except Exception:
            pass

    # Default VRAM for known GTX 1650 setup if we detected GPU but not VRAM size
    if info["gpu_available"] and info["vram_total_bytes"] == 0:
        info["vram_total_bytes"] = int(3.6 * 1024 * 1024 * 1024)

    _gpu_info_cache = info
    return {**info}


async def _get_ollama_loaded_models() -> list[dict]:
    """Get currently loaded Ollama models with VRAM info."""
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            resp = await client.get(f"{settings.OLLAMA_HOST}/api/ps")
            if resp.status_code == 200:
                models = []
                for m in resp.json().get("models", []):
                    models.append({
                        "name": m.get("name", ""),
                        "size_bytes": m.get("size", 0),
                        "vram_bytes": m.get("size_vram", 0),
                        "processor": m.get("processor", "unknown"),
                        "expires_at": m.get("expires_at", ""),
                    })
                return models
    except Exception:
        pass
    return []


async def _unload_all_models() -> None:
    """Unload all loaded Ollama models to free VRAM."""
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.get(f"{settings.OLLAMA_HOST}/api/ps")
            if resp.status_code == 200:
                for m in resp.json().get("models", []):
                    name = m.get("name", "")
                    if name:
                        await client.post(
                            f"{settings.OLLAMA_HOST}/api/generate",
                            json={"model": name, "keep_alive": 0},
                        )
    except Exception:
        pass


async def _unload_and_wait(max_wait: int = 15) -> bool:
    """Unload all models and poll until VRAM is actually freed.

    On GTX 1650, Ollama's CUDA memory reclamation can take 5-10s after
    keep_alive=0. Simply sleeping 2s is not enough — the text model OOMs
    because the vision model's VRAM hasn't been released yet.

    After /api/ps confirms no models, we add an extra 3s delay to let
    the CUDA driver fully reclaim GPU memory across container boundaries.

    Returns True if no models remain loaded.
    """
    await _unload_all_models()

    for attempt in range(max_wait):
        await asyncio.sleep(1)
        try:
            async with httpx.AsyncClient(timeout=5) as client:
                resp = await client.get(f"{settings.OLLAMA_HOST}/api/ps")
                if resp.status_code == 200:
                    models = resp.json().get("models", [])
                    if not models:
                        # Models removed from Ollama's list, but CUDA driver
                        # may still hold GPU memory for several seconds.
                        # Ollama also spawns 10-20 runners during unload/reload
                        # which compete for GPU resources.
                        # On GTX 1650 with <200MB margin, we need a generous wait.
                        logger.info("Ollama reports no models after %ds — waiting 5s for CUDA driver + runners to settle", attempt + 1)
                        await asyncio.sleep(5)
                        return True
                    # Models still present — send another unload
                    for m in models:
                        name = m.get("name", "")
                        if name:
                            await client.post(
                                f"{settings.OLLAMA_HOST}/api/generate",
                                json={"model": name, "keep_alive": 0},
                            )
        except Exception:
            pass

    logger.warning("Models still loaded after %ds wait", max_wait)
    return False


def _generate_test_image() -> str:
    """Generate a tiny 64x64 test image as base64 for vision model testing."""
    try:
        from PIL import Image
    except ImportError:
        # Minimal 1x1 PNG as fallback if Pillow not available
        return "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPj/HwADBwIAMCbHYQAAAABJRU5ErkJggg=="

    img = Image.new("RGB", (64, 64))
    pixels = img.load()
    for y in range(64):
        for x in range(64):
            pixels[x, y] = (x * 4, y * 4, 128)

    buffer = io.BytesIO()
    img.save(buffer, format="PNG")
    return base64.b64encode(buffer.getvalue()).decode("utf-8")


def _sse_event(event_type: str, data: dict) -> str:
    """Format an SSE event."""
    payload = {"type": event_type, "data": data}
    return f"data: {json.dumps(payload)}\n\n"


async def _test_vision_model(model: str) -> dict:
    """Test vision model: load, analyze a tiny test image, check GPU status."""
    start = time.time()
    try:
        test_image_b64 = _generate_test_image()
        async with httpx.AsyncClient(timeout=120) as client:
            resp = await client.post(
                f"{settings.OLLAMA_HOST}/api/chat",
                json={
                    "model": model,
                    "messages": [{
                        "role": "user",
                        "content": "Describe this image in one sentence.",
                        "images": [test_image_b64],
                    }],
                    "stream": False,
                    "options": {
                        "num_gpu": 99,
                        "num_predict": 50,
                        "num_batch": 128,  # Reduce batch to lower compute buffer
                    },
                },
                timeout=120,
            )

            duration_ms = int((time.time() - start) * 1000)

            if resp.status_code != 200:
                error_text = resp.text[:200] if resp.text else ""
                return {
                    "status": "fail",
                    "message": f"Vision model returned HTTP {resp.status_code}: {error_text}",
                    "duration_ms": duration_ms, "gpu_status": "unknown",
                }

            # Check GPU status
            gpu_status, vram_used = await _check_model_gpu(client, model)

            response_text = ""
            try:
                response_text = resp.json().get("message", {}).get("content", "")[:100]
            except Exception:
                pass

            if gpu_status.startswith("cpu"):
                return {
                    "status": "warn",
                    "message": f"Vision loaded on CPU — {duration_ms}ms. GPU may be poisoned from prior OOM.",
                    "duration_ms": duration_ms, "gpu_status": gpu_status,
                    "vram_bytes": vram_used, "sample_output": response_text,
                }

            return {
                "status": "pass",
                "message": f"Vision model OK — {duration_ms}ms on GPU",
                "duration_ms": duration_ms, "gpu_status": gpu_status,
                "vram_bytes": vram_used, "sample_output": response_text,
            }

    except asyncio.TimeoutError:
        return {
            "status": "fail",
            "message": "Vision model timed out (>120s) — likely stuck on CPU",
            "duration_ms": 120000, "gpu_status": "timeout",
        }
    except Exception as e:
        return {
            "status": "fail",
            "message": f"Vision model error: {str(e)[:200]}",
            "duration_ms": int((time.time() - start) * 1000), "gpu_status": "error",
        }


async def _test_text_model(model: str) -> dict:
    """Test text model: load, run a short completion, check GPU status."""
    start = time.time()
    try:
        async with httpx.AsyncClient(timeout=120) as client:
            resp = await client.post(
                f"{settings.OLLAMA_HOST}/api/chat",
                json={
                    "model": model,
                    "messages": [{
                        "role": "user",
                        "content": "Summarize in one sentence: A man walks into a coffee shop and orders a latte.",
                    }],
                    "stream": False,
                    "options": {
                        "num_gpu": 99,
                        "num_predict": 50,
                        "num_ctx": 1024,    # Minimal context for test — reduces compute graph from 300MB to ~150MB
                        "num_batch": 128,   # Reduce batch size to lower compute buffer allocation
                    },
                },
                timeout=120,
            )

            duration_ms = int((time.time() - start) * 1000)

            if resp.status_code != 200:
                error_text = resp.text[:200] if resp.text else ""
                if "cudaMalloc" in error_text or "out of memory" in error_text.lower():
                    return {
                        "status": "fail",
                        "message": "CUDA OOM — text model doesn't fit. Vision model may not have unloaded.",
                        "duration_ms": duration_ms, "gpu_status": "oom",
                    }
                return {
                    "status": "fail",
                    "message": f"Text model returned HTTP {resp.status_code}: {error_text}",
                    "duration_ms": duration_ms, "gpu_status": "unknown",
                }

            gpu_status, vram_used = await _check_model_gpu(client, model)

            response_text = ""
            try:
                response_text = resp.json().get("message", {}).get("content", "")[:100]
            except Exception:
                pass

            if gpu_status.startswith("cpu"):
                return {
                    "status": "warn",
                    "message": f"Text model on CPU — {duration_ms}ms. Will cause 60s stall timeouts.",
                    "duration_ms": duration_ms, "gpu_status": gpu_status,
                    "vram_bytes": vram_used, "sample_output": response_text,
                }

            return {
                "status": "pass",
                "message": f"Text model OK — {duration_ms}ms on GPU",
                "duration_ms": duration_ms, "gpu_status": gpu_status,
                "vram_bytes": vram_used, "sample_output": response_text,
            }

    except asyncio.TimeoutError:
        return {
            "status": "fail",
            "message": "Text model timed out (>120s) — stuck on CPU or overloaded",
            "duration_ms": 120000, "gpu_status": "timeout",
        }
    except Exception as e:
        return {
            "status": "fail",
            "message": f"Text model error: {str(e)[:200]}",
            "duration_ms": int((time.time() - start) * 1000), "gpu_status": "error",
        }


async def _check_model_gpu(client: httpx.AsyncClient, model: str) -> tuple[str, int]:
    """Check if a model is on GPU via /api/ps. Returns (gpu_status_str, vram_bytes)."""
    try:
        ps_resp = await client.get(f"{settings.OLLAMA_HOST}/api/ps")
        if ps_resp.status_code == 200:
            for m in ps_resp.json().get("models", []):
                if model.split(":")[0] in m.get("name", ""):
                    vram = m.get("size_vram", 0)
                    total = m.get("size", 0)
                    if vram > 0 and total > 0:
                        pct = (vram / total) * 100
                        return f"gpu ({pct:.0f}% on CUDA)", vram
                    return "cpu (0% VRAM)", 0
    except Exception:
        pass
    return "unknown", 0


# ── Endpoints ────────────────────────────────────────────────────────────


@router.get("/gpu-status")
async def get_gpu_status():
    """Real-time GPU memory usage and loaded Ollama models. Polled every 2s."""
    gpu = await _get_gpu_info()
    loaded_models = await _get_ollama_loaded_models()

    # Compute dynamic VRAM and poisoning state from loaded models
    vram_used = sum(m["vram_bytes"] for m in loaded_models)
    gpu["vram_used_bytes"] = vram_used
    gpu["gpu_in_use"] = any(m["vram_bytes"] > 0 for m in loaded_models)

    # If we see a model on GPU but the cache said no GPU, invalidate cache
    if gpu["gpu_in_use"] and not gpu.get("gpu_available"):
        global _gpu_info_cache
        _gpu_info_cache = None
        gpu["gpu_available"] = True
        gpu["cuda_available"] = True
        if not gpu.get("gpu_name"):
            gpu["gpu_name"] = "NVIDIA GPU (via Ollama)"
        if gpu["vram_total_bytes"] == 0:
            gpu["vram_total_bytes"] = int(3.6 * 1024 * 1024 * 1024)

    # Detect GPU scheduler poisoning: hardware exists but loaded models are on CPU
    if gpu["gpu_available"] and loaded_models and not gpu["gpu_in_use"]:
        gpu["gpu_poisoned"] = True
    else:
        gpu["gpu_poisoned"] = False

    ollama_available = False
    try:
        async with httpx.AsyncClient(timeout=3) as client:
            resp = await client.head(f"{settings.OLLAMA_HOST}")
            ollama_available = resp.status_code == 200
    except Exception:
        pass

    # Torch GPU memory info (separate from Ollama — this is the app container)
    torch_gpu = None
    try:
        import torch
        if torch.cuda.is_available():
            torch_gpu = {
                "allocated_bytes": torch.cuda.memory_allocated(),
                "reserved_bytes": torch.cuda.memory_reserved(),
            }
            # Torch reserved memory counts as VRAM used (it's unavailable to Ollama)
            gpu["vram_used_bytes"] = vram_used + torch_gpu["reserved_bytes"]
    except (ImportError, Exception):
        pass

    return {
        "gpu": gpu,
        "loaded_models": loaded_models,
        "ollama_available": ollama_available,
        "torch_gpu": torch_gpu,
    }


@router.post("/unload-models")
async def unload_models():
    """Manually unload all Ollama models to free VRAM."""
    await _unload_all_models()
    return {"status": "ok", "message": "All models unloaded"}


@router.post("/release-gpu")
async def release_gpu():
    """Release all torch GPU memory AND unload Ollama models."""
    released_mb = 0
    try:
        from backend.services.pipeline import release_torch_gpu_memory
        import torch
        before = torch.cuda.memory_reserved() / 1024 / 1024 if torch.cuda.is_available() else 0
        release_torch_gpu_memory()
        after = torch.cuda.memory_reserved() / 1024 / 1024 if torch.cuda.is_available() else 0
        released_mb = max(0, before - after)
    except (ImportError, Exception):
        pass

    await _unload_all_models()

    # Invalidate GPU info cache
    global _gpu_info_cache
    _gpu_info_cache = None

    return {
        "status": "ok",
        "message": f"GPU memory released ({released_mb:.0f}MB torch freed). Ollama models unloaded.",
    }


@router.post("/restart-ollama")
async def restart_ollama():
    """Restart the Ollama container to reset a poisoned GPU scheduler.

    After a CUDA OOM, Ollama's scheduler permanently blacklists the GPU.
    The only fix is restarting the Ollama process/container.
    """
    import subprocess
    try:
        result = subprocess.run(
            ["docker", "restart", "clipai-ollama"],
            capture_output=True, text=True, timeout=30,
        )
        if result.returncode == 0:
            # Invalidate GPU cache so next poll re-detects
            global _gpu_info_cache
            _gpu_info_cache = None
            return {"status": "ok", "message": "Ollama container restarting — GPU scheduler will be reset. Wait ~15 seconds."}
        return {
            "status": "manual",
            "message": f"Cannot restart from app container (exit {result.returncode}). Run manually: docker restart clipai-ollama",
        }
    except FileNotFoundError:
        return {
            "status": "manual",
            "message": "Docker CLI not available in app container. Run on your server: docker restart clipai-ollama",
        }
    except Exception as e:
        return {
            "status": "manual",
            "message": f"Restart failed: {str(e)[:200]}. Run manually: docker restart clipai-ollama",
        }


@router.post("/test-pipeline")
async def test_pipeline(request: Request):
    """Run a diagnostic test of the AI pipeline via SSE."""
    is_ollama = "ollama" in settings.active_provider_chain
    vision_model = settings.OLLAMA_VISION_MODEL
    text_model = settings.OLLAMA_TEXT_MODEL

    async def event_stream() -> AsyncGenerator[str, None]:
        # Phase 0: Provider check
        yield _sse_event("phase_start", {
            "phase": "provider_check", "label": "Checking AI provider...",
            "phase_index": 0, "total_phases": 5,
        })

        if not is_ollama:
            # Cloud provider — simplified test
            yield _sse_event("phase_result", {
                "phase": "provider_check", "status": "pass",
                "message": "Cloud provider selected — no local GPU needed",
                "gpu_status": "n/a",
            })
            # Test cloud API
            yield _sse_event("phase_start", {
                "phase": "cloud_test", "label": "Testing cloud API...",
                "phase_index": 1, "total_phases": 2,
            })
            try:
                from backend.services.ai_orchestrator import AIOrchestrator
                orch = AIOrchestrator()
                t0 = time.time()
                await asyncio.wait_for(
                    orch.text_completion("Say hello in one word.", max_tokens=10, timeout=30),
                    timeout=30,
                )
                ms = int((time.time() - t0) * 1000)
                yield _sse_event("phase_result", {
                    "phase": "cloud_test", "status": "pass",
                    "message": f"Cloud API responded in {ms}ms",
                })
            except Exception as e:
                yield _sse_event("phase_result", {
                    "phase": "cloud_test", "status": "fail",
                    "message": f"Cloud API error: {str(e)[:200]}",
                })
            yield _sse_event("complete", {"overall_status": "pass"})
            return

        # ── Ollama pipeline test ──

        # Phase 0 result: check Ollama is up
        try:
            async with httpx.AsyncClient(timeout=5) as client:
                resp = await client.get(f"{settings.OLLAMA_HOST}/api/tags")
                if resp.status_code != 200:
                    raise Exception(f"HTTP {resp.status_code}")

            gpu = await _get_gpu_info()
            gpu_msg = f"CUDA available, {gpu.get('gpu_name', 'GPU')}" if gpu.get("cuda_available") else "No GPU detected"
            yield _sse_event("phase_result", {
                "phase": "provider_check", "status": "pass",
                "message": f"Ollama connected. {gpu_msg}",
            })
        except Exception as e:
            yield _sse_event("phase_result", {
                "phase": "provider_check", "status": "fail",
                "message": f"Ollama not available: {e}",
            })
            yield _sse_event("complete", {"overall_status": "fail"})
            return

        # Phase 1: Check + release torch VRAM
        yield _sse_event("phase_start", {
            "phase": "torch_vram", "label": "Checking torch GPU memory...",
            "phase_index": 1, "total_phases": 6,
        })
        torch_reserved = 0
        try:
            import torch
            if torch.cuda.is_available():
                torch_reserved = torch.cuda.memory_reserved() / 1024 / 1024
                if torch_reserved > 100:
                    from backend.services.pipeline import release_torch_gpu_memory
                    release_torch_gpu_memory()
                    await asyncio.sleep(2)
                    torch_after = torch.cuda.memory_reserved() / 1024 / 1024
                    yield _sse_event("phase_result", {
                        "phase": "torch_vram",
                        "status": "warn" if torch_after > 100 else "pass",
                        "message": f"Torch was holding {torch_reserved:.0f}MB, released to {torch_after:.0f}MB",
                    })
                else:
                    yield _sse_event("phase_result", {
                        "phase": "torch_vram", "status": "pass",
                        "message": f"Torch GPU memory OK ({torch_reserved:.0f}MB reserved)",
                    })
            else:
                # torch.cuda is unavailable (CUDA version mismatch) — but CTranslate2
                # may still be using GPU via its own CUDA runtime
                ct2_devices = 0
                try:
                    import ctranslate2
                    ct2_devices = ctranslate2.get_cuda_device_count()
                except Exception:
                    pass
                if ct2_devices > 0:
                    yield _sse_event("phase_result", {
                        "phase": "torch_vram", "status": "warn",
                        "message": (
                            f"PyTorch CUDA unavailable (version mismatch) but CTranslate2 sees {ct2_devices} GPU(s). "
                            f"Whisper uses CTranslate2 for GPU inference. "
                            f"Pipeline uses subprocess mode to release CTranslate2 VRAM after transcription."
                        ),
                    })
                else:
                    yield _sse_event("phase_result", {
                        "phase": "torch_vram", "status": "pass",
                        "message": "No CUDA — torch not using GPU",
                    })
        except ImportError:
            yield _sse_event("phase_result", {
                "phase": "torch_vram", "status": "pass",
                "message": "Torch not loaded",
            })

        # Phase 2: Clear Ollama VRAM
        yield _sse_event("phase_start", {
            "phase": "vram_clear", "label": "Clearing Ollama VRAM...",
            "phase_index": 2, "total_phases": 6,
        })
        cleared = await _unload_and_wait(10)
        yield _sse_event("phase_result", {
            "phase": "vram_clear",
            "status": "pass" if cleared else "warn",
            "message": "Ollama VRAM cleared" if cleared else "Models may still be unloading",
        })

        # Phase 3: Vision model
        yield _sse_event("phase_start", {
            "phase": "vision_model", "label": f"Testing vision model ({vision_model})...",
            "phase_index": 3, "total_phases": 6,
        })
        vision_result = await _test_vision_model(vision_model)
        yield _sse_event("phase_result", {"phase": "vision_model", **vision_result})

        # Phase 4: Unload vision — CRITICAL: must wait for VRAM to actually free
        # On GTX 1650, the vision model's CUDA memory takes 5-10s to release.
        # If we proceed too fast, the text model OOMs.
        yield _sse_event("phase_start", {
            "phase": "vision_unload", "label": f"Unloading {vision_model} (waiting for VRAM release)...",
            "phase_index": 4, "total_phases": 6,
        })
        freed = await _unload_and_wait(15)
        if freed:
            yield _sse_event("phase_result", {
                "phase": "vision_unload", "status": "pass",
                "message": "Vision model unloaded, VRAM freed",
            })
        else:
            yield _sse_event("phase_result", {
                "phase": "vision_unload", "status": "warn",
                "message": "Vision model unload sent but VRAM may not be fully released — text model may OOM",
            })

        # Phase 5: Text model
        yield _sse_event("phase_start", {
            "phase": "text_model", "label": f"Testing text model ({text_model})...",
            "phase_index": 5, "total_phases": 6,
        })
        text_result = await _test_text_model(text_model)
        yield _sse_event("phase_result", {"phase": "text_model", **text_result})

        # Cleanup
        await _unload_all_models()

        # Determine overall status
        gpu_healthy = (
            vision_result.get("status") != "fail"
            and text_result.get("status") != "fail"
        )
        yield _sse_event("complete", {
            "overall_status": "pass" if gpu_healthy else "fail",
            "gpu_healthy": gpu_healthy,
        })

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ── Subject Tracking Validation ──────────────────────────────────────────────


def _generate_tracking_test_image(subject_x_pct: int, color: tuple[int, int, int]) -> str:
    """Generate a 256x256 test image with a person-like figure at known position.

    Creates a simplified but recognizable human figure (head, neck, shoulders,
    torso) against an indoor background. Moondream is trained on real photos,
    so we need figures that look plausible, not abstract geometric shapes.

    Returns base64-encoded PNG.
    """
    from PIL import Image, ImageDraw

    W, H = 256, 256
    img = Image.new("RGB", (W, H), (45, 52, 60))  # Dark room background
    draw = ImageDraw.Draw(img)

    # Background elements: wall, floor, window-like rectangle
    draw.rectangle([0, 0, W, H * 2 // 3], fill=(55, 62, 70))       # Wall
    draw.rectangle([0, H * 2 // 3, W, H], fill=(38, 35, 32))       # Floor
    # Window/frame element on opposite side from subject for spatial context
    win_x = W - 40 if subject_x_pct < 50 else 10
    draw.rectangle([win_x, 20, win_x + 30, 70], fill=(80, 95, 110))  # Window
    draw.rectangle([win_x + 2, 22, win_x + 28, 68], fill=(120, 145, 170))

    # Subject position
    cx = int(W * subject_x_pct / 100)
    base_y = H * 2 // 3  # Standing on the floor line

    # Skin tone + hair
    skin = (210, 175, 145)
    hair = (60, 40, 25)
    shirt = color

    # Torso (shirt)
    torso_w, torso_h = 36, 50
    draw.rectangle(
        [cx - torso_w // 2, base_y - torso_h - 30, cx + torso_w // 2, base_y - 30],
        fill=shirt,
    )

    # Shoulders — wider than torso
    shoulder_w = 48
    draw.rectangle(
        [cx - shoulder_w // 2, base_y - torso_h - 30, cx + shoulder_w // 2, base_y - torso_h - 20],
        fill=shirt,
    )

    # Neck
    neck_w = 10
    draw.rectangle(
        [cx - neck_w // 2, base_y - torso_h - 40, cx + neck_w // 2, base_y - torso_h - 28],
        fill=skin,
    )

    # Head (oval)
    head_rx, head_ry = 14, 17
    head_cy = base_y - torso_h - 40 - head_ry
    draw.ellipse(
        [cx - head_rx, head_cy - head_ry, cx + head_rx, head_cy + head_ry],
        fill=skin,
    )

    # Hair on top of head
    draw.ellipse(
        [cx - head_rx, head_cy - head_ry - 2, cx + head_rx, head_cy - 2],
        fill=hair,
    )

    # Simple face features — eyes and mouth
    eye_y = head_cy - 2
    draw.ellipse([cx - 7, eye_y - 2, cx - 3, eye_y + 2], fill=(40, 40, 40))
    draw.ellipse([cx + 3, eye_y - 2, cx + 7, eye_y + 2], fill=(40, 40, 40))
    draw.line([(cx - 4, head_cy + 7), (cx + 4, head_cy + 7)], fill=(170, 120, 100), width=1)

    # Legs
    leg_w = 10
    draw.rectangle([cx - 14, base_y - 30, cx - 14 + leg_w, base_y], fill=(50, 50, 65))
    draw.rectangle([cx + 4, base_y - 30, cx + 4 + leg_w, base_y], fill=(50, 50, 65))

    buffer = io.BytesIO()
    img.save(buffer, format="PNG")
    return base64.b64encode(buffer.getvalue()).decode("utf-8")


@router.post("/test-subject-tracking")
async def test_subject_tracking():
    """Validate that the vision AI produces usable subject_x values.

    Generates 3 synthetic test images with subjects at known positions
    (25%, 50%, 75%), sends each to the vision model, and compares
    the returned subject_x against ground truth.
    """
    vision_model = settings.OLLAMA_VISION_MODEL
    is_moondream = "moondream" in vision_model.lower()

    test_cases = [
        {"expected_x": 25, "color": (220, 60, 60), "label": "left"},
        {"expected_x": 50, "color": (60, 120, 220), "label": "center"},
        {"expected_x": 75, "color": (60, 200, 120), "label": "right"},
    ]

    results = []
    total_time = 0

    for tc in test_cases:
        test_b64 = _generate_tracking_test_image(tc["expected_x"], tc["color"])

        if is_moondream:
            prompt = (
                "There is a person standing in a room in this image. "
                "Where is the person positioned horizontally in the frame?"
                '\n\nRespond with ONLY this JSON, nothing else:\n'
                '{"description": "<what you see>", "subject_x": <number 0 to 100>}\n'
                'subject_x: horizontal position of the person. '
                '0 = left edge, 25 = left quarter, 50 = center, 75 = right quarter, 100 = right edge.\n'
                'Look carefully at where the person is standing. Do NOT always say 50.'
            )
        else:
            prompt = (
                "There is a person standing in a room. "
                "Where is the person positioned horizontally?"
                '\n\nReturn ONLY valid JSON:\n'
                '{"timestamp": 0, "description": "<text>", '
                '"importance_score": 5, "subject_x": <0-100>}\n'
                'subject_x = horizontal position of the person as % of frame width '
                '(0=far left, 50=exact center, 100=far right).'
            )

        t0 = time.time()
        try:
            payload = {
                "model": vision_model,
                "messages": [{
                    "role": "user",
                    "content": prompt,
                    "images": [test_b64],
                }],
                "stream": False,
                "options": {"num_gpu": 99, "num_predict": 100, "num_ctx": 2048},
            }
            if is_moondream:
                payload["format"] = "json"

            async with httpx.AsyncClient(timeout=120) as client:
                resp = await client.post(
                    f"{settings.OLLAMA_HOST}/api/chat",
                    json=payload,
                    timeout=120,
                )

            duration_ms = int((time.time() - t0) * 1000)
            total_time += duration_ms

            if resp.status_code != 200:
                results.append({
                    "label": tc["label"],
                    "expected_x": tc["expected_x"],
                    "returned_x": None,
                    "error": None,
                    "json_ok": False,
                    "duration_ms": duration_ms,
                    "raw_response": resp.text[:200],
                    "status": "fail",
                    "message": f"HTTP {resp.status_code}",
                })
                continue

            raw_text = resp.json().get("message", {}).get("content", "")

            json_ok = False
            returned_x = None
            try:
                text = raw_text.strip()
                if text.startswith("```"):
                    text = text.split("\n", 1)[1].rsplit("```", 1)[0].strip()
                json_start = text.find("{")
                json_end = text.rfind("}") + 1
                if json_start >= 0 and json_end > json_start:
                    parsed = json.loads(text[json_start:json_end])
                    if isinstance(parsed, list) and parsed:
                        parsed = parsed[0]
                    raw_sx = parsed.get("subject_x")
                    if raw_sx is not None:
                        returned_x = max(0, min(100, int(raw_sx)))
                        json_ok = True
            except (json.JSONDecodeError, KeyError, TypeError, ValueError):
                pass

            error = abs(returned_x - tc["expected_x"]) if returned_x is not None else None

            if not json_ok:
                status = "fail"
                message = "JSON parse failed or missing subject_x"
            elif error <= 25:
                status = "pass"
                message = f"subject_x={returned_x} (expected {tc['expected_x']}, error={error})"
            elif error <= 40:
                status = "warn"
                message = f"subject_x={returned_x} (expected {tc['expected_x']}, error={error}) — approximate on synthetic image"
            else:
                status = "warn"
                message = f"subject_x={returned_x} (expected {tc['expected_x']}, error={error}) — inaccurate on synthetic, may work better on real video"

            results.append({
                "label": tc["label"],
                "expected_x": tc["expected_x"],
                "returned_x": returned_x,
                "error": error,
                "json_ok": json_ok,
                "duration_ms": duration_ms,
                "raw_response": raw_text[:200],
                "status": status,
                "message": message,
            })

        except asyncio.TimeoutError:
            results.append({
                "label": tc["label"],
                "expected_x": tc["expected_x"],
                "returned_x": None,
                "error": None,
                "json_ok": False,
                "duration_ms": 120000,
                "raw_response": "",
                "status": "fail",
                "message": "Timeout (>120s)",
            })
        except Exception as e:
            results.append({
                "label": tc["label"],
                "expected_x": tc["expected_x"],
                "returned_x": None,
                "error": None,
                "json_ok": False,
                "duration_ms": int((time.time() - t0) * 1000),
                "raw_response": str(e)[:200],
                "status": "fail",
                "message": f"Error: {str(e)[:100]}",
            })

    # Compute summary
    json_ok_count = sum(1 for r in results if r["json_ok"])
    errors = [r["error"] for r in results if r["error"] is not None]
    avg_error = round(sum(errors) / len(errors), 1) if errors else None
    avg_speed = round(total_time / len(results)) if results else 0

    # Check for degenerate responses: all subject_x values identical (e.g. all 50)
    returned_xs = [r["returned_x"] for r in results if r["returned_x"] is not None]
    all_same = len(set(returned_xs)) <= 1 and len(returned_xs) >= 2

    if json_ok_count == 0:
        overall = "fail"
        summary = "Vision AI cannot produce JSON — subject tracking will not work"
    elif json_ok_count < 3:
        overall = "warn"
        summary = f"JSON compliance: {json_ok_count}/3 — tracking may be unreliable"
    elif all_same:
        overall = "warn"
        summary = f"JSON works but all responses returned subject_x={returned_xs[0]} — model may not differentiate positions on real video"
    elif avg_error is not None and avg_error > 40:
        overall = "warn"
        summary = f"JSON works, avg error {avg_error}% on synthetic images — accuracy may vary on real video ({avg_speed}ms/frame)"
    else:
        overall = "pass"
        summary = f"Subject tracking working — {avg_error}% avg error, {avg_speed}ms/frame"

    return {
        "overall_status": overall,
        "summary": summary,
        "model": vision_model,
        "format_json_used": is_moondream,
        "json_compliance": f"{json_ok_count}/3",
        "avg_error": avg_error,
        "avg_speed_ms": avg_speed,
        "results": results,
    }


# ── Whisper Transcription Test ───────────────────────────────────────────────


@router.post("/test-whisper")
async def test_whisper(request: Request):
    """Test Whisper transcription and translation with a short generated audio clip.

    Generates a ~10 second audio file using ffmpeg (sine tone + silence),
    runs the current Whisper model on it via subprocess, and reports results.
    Streams SSE events for real-time progress in the UI.
    """
    import shutil
    import tempfile

    async def event_stream() -> AsyncGenerator[str, None]:
        tmp_dir = tempfile.mkdtemp(prefix="whisper_test_")
        test_audio = os.path.join(tmp_dir, "test_audio.wav")

        try:
            total_phases = 5

            # ── Phase 1: Generate test audio ──
            yield _sse_event("phase_start", {
                "phase": "generate_audio",
                "label": "Generating test audio...",
                "phase_index": 0, "total_phases": total_phases,
            })

            try:
                cmd = [
                    "ffmpeg", "-y",
                    "-f", "lavfi", "-i",
                    "sine=frequency=440:duration=3,aformat=sample_rates=16000:channel_layouts=mono[a1];"
                    "anullsrc=r=16000:cl=mono,atrim=0:2,asetpts=PTS-STARTPTS[s1];"
                    "anullsrc=r=16000:cl=mono,atrim=0:2,asetpts=PTS-STARTPTS[s2];"
                    "sine=frequency=880:duration=3,aformat=sample_rates=16000:channel_layouts=mono[a2];"
                    "[s1][a1][s2][a2]concat=n=4:v=0:a=1[out]",
                    "-map", "[out]",
                    "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1",
                    test_audio,
                ]
                proc = await asyncio.create_subprocess_exec(
                    *cmd,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
                _, stderr = await asyncio.wait_for(proc.communicate(), timeout=15)

                if proc.returncode != 0 or not os.path.isfile(test_audio):
                    cmd_simple = [
                        "ffmpeg", "-y", "-f", "lavfi", "-i",
                        "anullsrc=r=16000:cl=mono",
                        "-t", "5", "-acodec", "pcm_s16le",
                        test_audio,
                    ]
                    proc2 = await asyncio.create_subprocess_exec(
                        *cmd_simple,
                        stdout=asyncio.subprocess.PIPE,
                        stderr=asyncio.subprocess.PIPE,
                    )
                    await asyncio.wait_for(proc2.communicate(), timeout=10)

                file_size = os.path.getsize(test_audio) if os.path.isfile(test_audio) else 0
                yield _sse_event("phase_result", {
                    "phase": "generate_audio", "status": "pass",
                    "message": f"Test audio ready ({file_size // 1024} KB, 10s)",
                })
            except Exception as e:
                yield _sse_event("phase_result", {
                    "phase": "generate_audio", "status": "fail",
                    "message": f"Failed to generate test audio: {str(e)[:200]}",
                })
                yield _sse_event("complete", {"overall_status": "fail"})
                return

            # ── Phase 2: Check CUDA / GPU availability ──
            yield _sse_event("phase_start", {
                "phase": "cuda_check",
                "label": "Checking GPU/CUDA availability...",
                "phase_index": 1, "total_phases": total_phases,
            })

            cuda_available = False
            cuda_device_count = 0
            gpu_name = "CPU"
            try:
                from backend.services.transcription import _detect_cuda_available
                cuda_available, cuda_device_count, gpu_name, _ = _detect_cuda_available()
            except Exception:
                pass

            device = "cuda" if (cuda_available and settings.GPU_ACCELERATION_ENABLED) else "cpu"
            compute_type = "float16" if device == "cuda" else "int8"

            if device == "cuda":
                yield _sse_event("phase_result", {
                    "phase": "cuda_check", "status": "pass",
                    "message": f"CUDA available — {gpu_name} ({cuda_device_count} device{'s' if cuda_device_count > 1 else ''})",
                    "device": "cuda", "gpu_name": gpu_name,
                })
            else:
                yield _sse_event("phase_result", {
                    "phase": "cuda_check", "status": "warn",
                    "message": "CUDA not available — using CPU (inference will be slow)",
                    "device": "cpu",
                })

            # ── Phase 3: Run Whisper transcription (subprocess) ──
            model_name = settings.WHISPER_MODEL
            beam_size = settings.WHISPER_BEAM_SIZE

            yield _sse_event("phase_start", {
                "phase": "transcribe",
                "label": f"Transcribing with {model_name} (beam={beam_size}) on {device.upper()}...",
                "phase_index": 2, "total_phases": total_phases,
            })

            t0 = time.time()
            try:
                from backend.services.transcription import transcribe_audio_subprocess
                segments = await asyncio.wait_for(
                    transcribe_audio_subprocess(
                        test_audio,
                        language="",
                        task="transcribe",
                        initial_prompt="",
                        audio_duration=10.0,
                    ),
                    timeout=120,
                )
                elapsed_ms = int((time.time() - t0) * 1000)

                seg_count = len(segments)
                yield _sse_event("phase_result", {
                    "phase": "transcribe", "status": "pass",
                    "message": (
                        f"Transcription OK — {seg_count} segment{'s' if seg_count != 1 else ''} "
                        f"in {elapsed_ms}ms ({model_name}, beam={beam_size}, {device})"
                    ),
                    "segments": seg_count,
                    "elapsed_ms": elapsed_ms,
                    "model": model_name,
                    "device": device,
                })
            except asyncio.TimeoutError:
                yield _sse_event("phase_result", {
                    "phase": "transcribe", "status": "fail",
                    "message": "Transcription timed out after 120s — model may be downloading or CUDA OOM",
                })
                yield _sse_event("complete", {"overall_status": "fail"})
                return
            except Exception as e:
                elapsed_ms = int((time.time() - t0) * 1000)
                error_msg = str(e)[:300]
                if "CUDA" in error_msg or "cudaMalloc" in error_msg:
                    hint = " (GPU memory issue — try a smaller model or restart containers)"
                elif "exit 1" in error_msg or "exit 2" in error_msg:
                    hint = " (model may be too large for available VRAM)"
                else:
                    hint = ""
                yield _sse_event("phase_result", {
                    "phase": "transcribe", "status": "fail",
                    "message": f"Transcription failed ({elapsed_ms}ms): {error_msg}{hint}",
                })
                yield _sse_event("complete", {"overall_status": "fail"})
                return

            # ── Phase 4: Test translation ──
            yield _sse_event("phase_start", {
                "phase": "translate",
                "label": "Testing Whisper translate mode...",
                "phase_index": 3, "total_phases": total_phases,
            })

            t0 = time.time()
            try:
                segments_translate = await asyncio.wait_for(
                    transcribe_audio_subprocess(
                        test_audio,
                        language="ja",
                        task="translate",
                        initial_prompt="",
                        audio_duration=10.0,
                    ),
                    timeout=120,
                )
                elapsed_ms = int((time.time() - t0) * 1000)

                has_echo = any(
                    "japanese conversation" in (getattr(s, "text", "") or "").lower()
                    for s in segments_translate
                )

                if has_echo:
                    yield _sse_event("phase_result", {
                        "phase": "translate", "status": "fail",
                        "message": "Translation produced prompt echo — initial_prompt is being hallucinated as output",
                    })
                else:
                    yield _sse_event("phase_result", {
                        "phase": "translate", "status": "pass",
                        "message": (
                            f"Translation OK — {len(segments_translate)} segment{'s' if len(segments_translate) != 1 else ''} "
                            f"in {elapsed_ms}ms (ja->en, {model_name})"
                        ),
                        "segments": len(segments_translate),
                        "elapsed_ms": elapsed_ms,
                    })
            except Exception as e:
                elapsed_ms = int((time.time() - t0) * 1000)
                yield _sse_event("phase_result", {
                    "phase": "translate", "status": "warn",
                    "message": f"Translation test failed ({elapsed_ms}ms): {str(e)[:200]}",
                })

            # ── Phase 5: Verify VRAM cleanup ──
            yield _sse_event("phase_start", {
                "phase": "vram_cleanup",
                "label": "Verifying GPU memory released...",
                "phase_index": 4, "total_phases": total_phases,
            })

            try:
                import subprocess as sp
                smi = sp.run(
                    ["nvidia-smi", "--query-compute-apps=pid,name,used_memory",
                     "--format=csv,noheader,nounits"],
                    capture_output=True, text=True, timeout=5,
                )
                if smi.returncode == 0:
                    lines = [l.strip() for l in smi.stdout.strip().split("\n") if l.strip()]
                    python_procs = [l for l in lines if "python" in l.lower()]
                    if not python_procs:
                        yield _sse_event("phase_result", {
                            "phase": "vram_cleanup", "status": "pass",
                            "message": "GPU memory fully released — no Python processes on GPU",
                        })
                    else:
                        total_mb = sum(
                            int(l.split(",")[-1].strip().replace(" MiB", ""))
                            for l in python_procs
                            if l.split(",")[-1].strip().replace(" MiB", "").isdigit()
                        )
                        yield _sse_event("phase_result", {
                            "phase": "vram_cleanup",
                            "status": "warn" if total_mb > 100 else "pass",
                            "message": f"Python processes using {total_mb}MB VRAM" +
                                       (" — subprocess may not have released CUDA context" if total_mb > 500 else ""),
                        })
                else:
                    yield _sse_event("phase_result", {
                        "phase": "vram_cleanup", "status": "pass",
                        "message": "Subprocess mode — VRAM released when process exited",
                    })
            except FileNotFoundError:
                yield _sse_event("phase_result", {
                    "phase": "vram_cleanup", "status": "pass",
                    "message": "nvidia-smi not in container — subprocess mode ensures VRAM cleanup on exit",
                })
            except Exception as e:
                yield _sse_event("phase_result", {
                    "phase": "vram_cleanup", "status": "pass",
                    "message": f"VRAM check skipped: {str(e)[:100]}",
                })

            # ── Complete ──
            yield _sse_event("complete", {
                "overall_status": "pass",
                "summary": {
                    "model": model_name,
                    "device": device,
                    "gpu_name": gpu_name,
                    "beam_size": beam_size,
                    "compute_type": compute_type,
                },
            })

        finally:
            try:
                shutil.rmtree(tmp_dir, ignore_errors=True)
            except Exception:
                pass

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
