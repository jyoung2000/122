"""Pipeline diagnostics endpoints for GPU status monitoring and pipeline testing."""

import asyncio
import base64
import io
import json
import logging
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
    """Get GPU hardware info, cached after first call.

    Distinguishes between:
    - No GPU hardware at all
    - GPU hardware exists (cuda_available=True)
    The gpu_poisoned/gpu_in_use flags are computed per-request in the endpoint
    since they depend on loaded model state.
    """
    global _gpu_info_cache
    if _gpu_info_cache is not None:
        return {**_gpu_info_cache}  # Return a copy so callers can mutate

    info = {
        "gpu_available": False,
        "gpu_in_use": False,
        "gpu_poisoned": False,
        "gpu_name": None,
        "vram_total_bytes": 0,
        "vram_used_bytes": 0,
        "cuda_available": False,
    }

    # Try nvidia-smi (works even when Ollama's scheduler is poisoned)
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
                info["vram_total_bytes"] = int(parts[1].strip()) * 1024 * 1024
                info["gpu_available"] = True
                info["cuda_available"] = True
    except Exception:
        pass

    # Fallback: PyTorch CUDA detection
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
                    "options": {"num_gpu": 99, "num_predict": 50},
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
                    "options": {"num_gpu": 99, "num_predict": 50, "num_ctx": 2048},
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

    return {
        "gpu": gpu,
        "loaded_models": loaded_models,
        "ollama_available": ollama_available,
    }


@router.post("/unload-models")
async def unload_models():
    """Manually unload all Ollama models to free VRAM."""
    await _unload_all_models()
    return {"status": "ok", "message": "All models unloaded"}


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
            gpu_msg = f"CUDA available, {gpu['name']}" if gpu.get("cuda_available") else "No GPU detected"
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

        # Phase 1: Clear VRAM
        yield _sse_event("phase_start", {
            "phase": "vram_clear", "label": "Clearing VRAM...",
            "phase_index": 1, "total_phases": 5,
        })
        await _unload_all_models()
        await asyncio.sleep(2)
        yield _sse_event("phase_result", {
            "phase": "vram_clear", "status": "pass", "message": "VRAM cleared",
        })

        # Phase 2: Vision model
        yield _sse_event("phase_start", {
            "phase": "vision_model", "label": f"Testing vision model ({vision_model})...",
            "phase_index": 2, "total_phases": 5,
        })
        vision_result = await _test_vision_model(vision_model)
        yield _sse_event("phase_result", {"phase": "vision_model", **vision_result})

        # Phase 3: Unload vision
        yield _sse_event("phase_start", {
            "phase": "vision_unload", "label": f"Unloading {vision_model}...",
            "phase_index": 3, "total_phases": 5,
        })
        await _unload_all_models()
        await asyncio.sleep(2)
        yield _sse_event("phase_result", {
            "phase": "vision_unload", "status": "pass",
            "message": "Vision model unloaded, VRAM freed",
        })

        # Phase 4: Text model
        yield _sse_event("phase_start", {
            "phase": "text_model", "label": f"Testing text model ({text_model})...",
            "phase_index": 4, "total_phases": 5,
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
