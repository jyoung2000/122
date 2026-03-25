import logging
import os
import time
import threading
from concurrent.futures import ThreadPoolExecutor
from typing import Callable, Optional

from backend.config import settings
from backend.models import TranscriptSegment, WordTimestamp

logger = logging.getLogger(__name__)

_whisper_model = None
_model_lock = threading.Lock()
_loaded_model_name = None   # Tracks which model is currently in the singleton

# Stores the last detected language from Whisper auto-detection so the
# pipeline can read it after transcription completes.
_last_detected_language = {}

# Stores which diarization method was used ("neural" or "heuristic")
_last_diarization_method = {"method": "heuristic"}

# Exposed after model loads so the pipeline can report GPU info in status messages
whisper_device_info = {"device": "cpu", "compute_type": "int8", "gpu_name": ""}

# Dedicated thread pool for transcription so it never competes with
# the default executor (used for base64 encoding, etc.).  A single
# worker is sufficient because Whisper already parallelises internally.
_transcription_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="whisper")

# Timeout for model loading (download + init).  The first run downloads
# the model from HuggingFace which can take a while, but should not hang
# indefinitely.
_MODEL_LOAD_TIMEOUT = 600  # 10 minutes

# Per-segment stall timeout: if no new segment is produced within this
# many seconds, assume the model is stuck and return partial results.
_SEGMENT_STALL_TIMEOUT = 120  # 2 minutes


def _detect_cuda_available() -> tuple[bool, int, str, int]:
    """Try multiple methods to detect CUDA GPU availability.

    Returns (cuda_available, device_count, gpu_name, best_device_index).
    The best_device_index is the index of the most capable GPU (highest VRAM).
    """
    best_name, best_idx = _get_best_gpu()

    # Method 1: ctranslate2 (used by faster-whisper)
    try:
        import ctranslate2
        cuda_count = ctranslate2.get_cuda_device_count()
        if cuda_count > 0:
            gpu_name = best_name or f"CUDA GPU ({cuda_count} device{'s' if cuda_count > 1 else ''})"
            return True, cuda_count, gpu_name, best_idx
    except Exception:
        pass

    # Method 2: PyTorch CUDA (if torch is installed)
    try:
        import torch
        if torch.cuda.is_available():
            count = torch.cuda.device_count()
            name = best_name or (torch.cuda.get_device_name(0) if count > 0 else "CUDA GPU")
            return True, count, name, best_idx
    except Exception:
        pass

    # Method 3: Check for NVIDIA device nodes (GPU passed through but libraries incomplete)
    try:
        import glob
        nvidia_devs = glob.glob("/dev/nvidia[0-9]*")
        if nvidia_devs:
            gpu_name = best_name or _get_gpu_name_from_sysfs() or f"NVIDIA GPU ({len(nvidia_devs)} devices)"
            logger.info(
                "NVIDIA device nodes found (%s) but CUDA runtime not available. "
                "Install CUDA toolkit or use Dockerfile.gpu for GPU-accelerated Whisper.",
                nvidia_devs,
            )
            return False, 0, gpu_name, 0
    except Exception:
        pass

    # Method 4: Try loading CUDA library directly
    try:
        import ctypes
        for lib in ["libcuda.so.1", "libcuda.so", "nvcuda.dll"]:
            try:
                ctypes.cdll.LoadLibrary(lib)
                gpu_name = best_name or _get_gpu_name_from_sysfs() or "NVIDIA GPU"
                logger.info("CUDA library %s is loadable — GPU may be available for Whisper", lib)
                return True, 1, gpu_name, best_idx
            except OSError:
                continue
    except Exception:
        pass

    return False, 0, "", 0


def _enumerate_gpus_nvidia_smi() -> list[dict]:
    """Enumerate all NVIDIA GPUs via nvidia-smi.

    Returns list of {index, name, vram_mb} sorted by VRAM (most capable first).
    """
    try:
        import subprocess
        smi = subprocess.run(
            ["nvidia-smi", "--query-gpu=index,name,memory.total",
             "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=5,
        )
        if smi.returncode != 0 or not smi.stdout.strip():
            return []
        gpus = []
        for line in smi.stdout.strip().split("\n"):
            parts = [p.strip() for p in line.split(",")]
            if len(parts) >= 3:
                try:
                    gpus.append({
                        "index": int(parts[0]),
                        "name": parts[1],
                        "vram_mb": int(float(parts[2])),
                    })
                except (ValueError, IndexError):
                    continue
        # Sort by VRAM descending — prefer most capable GPU
        gpus.sort(key=lambda g: g["vram_mb"], reverse=True)
        return gpus
    except Exception:
        return []


def _get_best_gpu() -> tuple[str, int]:
    """Get the most capable GPU name and its device index.

    Returns (gpu_name, device_index). Prefers GPU with the most VRAM
    so a passed-through RTX 4070 is chosen over a server's GTX 1650.
    """
    gpus = _enumerate_gpus_nvidia_smi()
    if gpus:
        best = gpus[0]
        if len(gpus) > 1:
            logger.info(
                "Multiple GPUs detected: %s — selecting %s (index %d, %d MB VRAM)",
                ", ".join(f"{g['name']} [{g['index']}]" for g in gpus),
                best["name"], best["index"], best["vram_mb"],
            )
        return best["name"], best["index"]
    return "", 0


def _get_gpu_name_from_nvidia_smi() -> str:
    """Try to get GPU name from nvidia-smi (best/most capable GPU)."""
    name, _ = _get_best_gpu()
    return name


def _get_gpu_name_from_sysfs() -> str:
    """Try to get GPU name from /proc/driver/nvidia or sysfs."""
    try:
        import glob
        for info_path in glob.glob("/proc/driver/nvidia/gpus/*/information"):
            try:
                for line in open(info_path):
                    if line.startswith("Model:"):
                        return line.split(":", 1)[1].strip()
            except (OSError, IOError):
                continue
    except Exception:
        pass
    return ""


def _cleanup_old_model():
    """Release CUDA memory held by the current Whisper model.

    Must be called WITH _model_lock held. Handles the case where
    CTranslate2/PyTorch CUDA allocations linger after Python del.
    """
    global _whisper_model
    old = _whisper_model
    _whisper_model = None

    # Explicitly delete the model object to trigger CTranslate2's C++ destructor
    try:
        del old
    except Exception:
        pass

    # Force Python GC to run CTranslate2 destructor immediately
    import gc
    gc.collect()
    gc.collect()  # Second pass for reference cycles

    # Release PyTorch CUDA cache (CTranslate2 uses PyTorch under the hood)
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            torch.cuda.synchronize()
            free_mb = torch.cuda.mem_get_info()[0] / (1024 * 1024)
            logger.info("CUDA memory released after model cleanup — %.0fMB free", free_mb)
    except ImportError:
        pass
    except Exception as e:
        logger.debug("CUDA cleanup after model switch: %s", e)


def reload_model():
    """Force-reload the Whisper model on the next transcription call.

    Called when the model selection changes or GPU acceleration is toggled
    so the model can switch size/device without restarting the server.
    Properly cleans up CUDA memory from the old model.
    """
    global _whisper_model, _loaded_model_name
    with _model_lock:
        if _whisper_model is not None:
            _cleanup_old_model()
        _whisper_model = None
        _loaded_model_name = None
    logger.info("Whisper model cache cleared — will reload on next use")


def reload_diarization():
    """Force-reload the pyannote pipeline when HF_AUTH_TOKEN changes."""
    global _diarization_pipeline
    with _diarization_lock:
        _diarization_pipeline = None
    logger.info("pyannote diarization cache cleared — will reload on next use")


def _get_whisper_model():
    global _whisper_model, whisper_device_info, _loaded_model_name
    with _model_lock:
        # Reload if model is not loaded OR if settings changed since last load
        if _whisper_model is not None and _loaded_model_name != settings.WHISPER_MODEL:
            logger.info(
                "Whisper model mismatch: loaded='%s' but settings='%s' — reloading",
                _loaded_model_name, settings.WHISPER_MODEL,
            )
            _cleanup_old_model()
        if _whisper_model is None:
            from faster_whisper import WhisperModel

            # Pick best device and compute type using multi-method detection
            device = "cpu"
            compute_type = "int8"
            gpu_name = ""
            device_index = 0

            cuda_available, cuda_count, detected_name, best_device_idx = _detect_cuda_available()
            if not settings.GPU_ACCELERATION_ENABLED:
                # User has GPU acceleration disabled — force CPU even if
                # CUDA is available, but still record the GPU name for UI.
                gpu_name = detected_name
                logger.info(
                    "GPU acceleration disabled in settings — using CPU for Whisper"
                    + (f" (GPU detected: {gpu_name})" if gpu_name else "")
                )
            elif cuda_available and cuda_count > 0:
                device = "cuda"
                compute_type = "float16"
                gpu_name = detected_name

                # Use specific GPU device index if configured, otherwise use
                # the auto-detected best GPU (highest VRAM).
                gpu_device_idx = (settings.GPU_DEVICE_INDEX or "").strip()
                if gpu_device_idx and gpu_device_idx.isdigit():
                    idx = int(gpu_device_idx)
                    if idx < cuda_count:
                        device_index = idx
                    else:
                        logger.warning(
                            "GPU_DEVICE_INDEX=%s exceeds available CUDA devices (%d). Using best GPU at index %d.",
                            gpu_device_idx, cuda_count, best_device_idx,
                        )
                        device_index = best_device_idx
                else:
                    # Auto-select the most capable GPU (highest VRAM)
                    device_index = best_device_idx if best_device_idx < cuda_count else 0

                logger.info(
                    "CUDA GPU detected: %s — using float16 for Whisper on device %d (of %d)",
                    gpu_name or "unknown", device_index, cuda_count,
                )
            elif detected_name:
                # GPU detected but CUDA runtime not available
                logger.warning(
                    "GPU detected (%s) but CUDA runtime not available for Whisper. "
                    "Falling back to CPU. For GPU acceleration, ensure CUDA toolkit "
                    "is installed and the container has --gpus all.",
                    detected_name,
                )
                gpu_name = detected_name  # Record name even if can't use it

            whisper_device_info = {
                "device": device,
                "compute_type": compute_type,
                "gpu_name": gpu_name,
                "device_index": device_index,
            }

            # Build model kwargs — pass device_index for GPU selection
            model_kwargs = {
                "device": device,
                "compute_type": compute_type,
            }
            if device == "cuda":
                model_kwargs["device_index"] = device_index

            # Auto-upgrade model when GPU is available and user hasn't explicitly chosen.
            # VRAM-aware: large-v3-turbo needs ~3GB VRAM in float16. On 4GB GPUs,
            # this leaves <1GB headroom and crashes on complex audio segments
            # (multilingual, music, overlapping speakers cause transient VRAM spikes).
            # Skip if user explicitly selected a model in the UI (WHISPER_MODEL_USER_SET).
            if (device == "cuda" and settings.WHISPER_MODEL == "small"
                    and not getattr(settings, 'WHISPER_MODEL_USER_SET', False)):
                gpus = _enumerate_gpus_nvidia_smi()
                vram_mb = gpus[0]["vram_mb"] if gpus else 0
                if vram_mb >= 8000:
                    settings.WHISPER_MODEL = "large-v3"
                    logger.info("Auto-upgraded Whisper to large-v3 (%dMB VRAM)", vram_mb)
                elif vram_mb >= 6000:
                    settings.WHISPER_MODEL = "large-v3-turbo"
                    logger.info("Auto-upgraded Whisper to large-v3-turbo (%dMB VRAM)", vram_mb)
                else:
                    # 4GB or less: keep 'small' (~500MB VRAM) to avoid CUDA OOM.
                    # large-v3-turbo crashed at 4:31 on a 113-min Japanese video
                    # in production — 18 segments collected then lost.
                    logger.info(
                        "Keeping Whisper 'small' — %dMB VRAM insufficient for "
                        "large-v3-turbo (needs ~3GB, risks CUDA OOM on complex audio)",
                        vram_mb,
                    )

            # ── VRAM safety: auto-DOWNGRADE user-selected models that won't fit ──
            # Whisper VRAM requirements (float16, approximate):
            #   tiny:  ~0.4GB    base:  ~0.5GB    small: ~1.0GB
            #   medium: ~2.5GB   large-v3: ~3.5GB  large-v3-turbo: ~3.0GB
            # On 4GB GPUs, medium+ models crash on long audio (KV cache grows
            # with duration). Downgrade to small with a loud warning.
            # VRAM requirements = minimum TOTAL GPU memory needed.
            # These assume exclusive GPU access (Ollama unloaded before Whisper).
            # medium (~1.5GB model + ~0.5GB beam/KV + ~0.3GB buffers = ~2.3GB peak)
            # needs ~3GB total to leave headroom for CUDA spikes on complex audio.
            _VRAM_REQUIREMENTS = {
                "large-v3": 6000,       # ~3.5GB model alone
                "large-v3-turbo": 5000, # ~3.0GB model alone
                "medium": 3000,         # ~1.5GB model + ~0.5GB beam + ~0.3GB buffers
                "medium.en": 3000,
            }
            if device == "cuda" and settings.WHISPER_MODEL in _VRAM_REQUIREMENTS:
                # Try nvidia-smi first, fall back to PyTorch CUDA reporting
                # (nvidia-smi is NOT available in Docker containers without NVIDIA runtime)
                gpus = _enumerate_gpus_nvidia_smi()
                vram_mb = gpus[0]["vram_mb"] if gpus else 0
                if vram_mb == 0:
                    try:
                        import torch
                        if torch.cuda.is_available():
                            vram_mb = int(torch.cuda.get_device_properties(0).total_mem / 1024 / 1024)
                            logger.info("VRAM detected via PyTorch: %dMB", vram_mb)
                    except Exception:
                        pass
                min_vram = _VRAM_REQUIREMENTS[settings.WHISPER_MODEL]
                if 0 < vram_mb < min_vram:
                    original = settings.WHISPER_MODEL
                    settings.WHISPER_MODEL = "small"
                    logger.warning(
                        "AUTO-DOWNGRADE: Whisper '%s' needs ~%dMB VRAM but GPU only has %dMB. "
                        "Downgrading to 'small' to prevent CUDA OOM on long audio. "
                        "To use '%s', you need a GPU with %dMB+ VRAM.",
                        original, min_vram, vram_mb, original, min_vram,
                    )

            # ── VRAM-aware beam size for inference ──
            # Estimate whether model + beam_size will fit in available VRAM.
            # Only reduce beam when the combination would actually exceed safe limits.
            # CTranslate2 catches cudaMalloc failures silently — returns empty results.
            if device == "cuda":
                _gpus = _enumerate_gpus_nvidia_smi()
                _vram = _gpus[0]["vram_mb"] if _gpus else 0
                if _vram == 0:
                    try:
                        import torch as _torch
                        if _torch.cuda.is_available():
                            _vram = int(_torch.cuda.get_device_properties(0).total_mem / 1024 / 1024)
                    except Exception:
                        pass

                # Estimate peak VRAM for current model + beam=N
                # Model weights (float16): tiny=400, base=500, small=1000, medium=1500,
                #   large-v3-turbo=3000, large-v3=3500
                _MODEL_VRAM_MB = {
                    "tiny": 400, "tiny.en": 400,
                    "base": 500, "base.en": 500,
                    "small": 1000, "small.en": 1000,
                    "medium": 1500, "medium.en": 1500,
                    "large-v3-turbo": 3000,
                    "large-v3": 3500, "large-v2": 3500, "large": 3500,
                }
                _model_mb = _MODEL_VRAM_MB.get(settings.WHISPER_MODEL, 1000)
                # Beam overhead: ~50MB per beam (KV cache + workspace)
                _beam_overhead = settings.WHISPER_BEAM_SIZE * 50
                # CUDA driver/context: ~400MB
                _cuda_overhead = 400
                _estimated_peak = _model_mb + _beam_overhead + _cuda_overhead
                # Usable VRAM (total minus driver)
                _usable = _vram - _cuda_overhead if _vram > 0 else 0

                if _vram > 0 and _estimated_peak > _vram * 0.85:
                    # Would exceed 85% of total VRAM — find safe beam size
                    # Work backward: max_beam = (usable * 0.85 - model) / 50
                    _safe_beam = max(1, int((_usable * 0.85 - _model_mb) / 50))
                    _safe_beam = min(_safe_beam, settings.WHISPER_BEAM_SIZE)
                    if _safe_beam < settings.WHISPER_BEAM_SIZE:
                        whisper_device_info["recommended_beam_size"] = _safe_beam
                        logger.info(
                            "VRAM-aware: beam %d→%d for %s on %dMB GPU "
                            "(est. peak %dMB, usable %dMB)",
                            settings.WHISPER_BEAM_SIZE, _safe_beam,
                            settings.WHISPER_MODEL, _vram, _estimated_peak, _usable,
                        )
                    else:
                        whisper_device_info["recommended_beam_size"] = None
                        logger.info(
                            "VRAM OK: %s + beam=%d fits on %dMB GPU "
                            "(est. peak %dMB, usable %dMB)",
                            settings.WHISPER_MODEL, settings.WHISPER_BEAM_SIZE,
                            _vram, _estimated_peak, _usable,
                        )
                else:
                    whisper_device_info["recommended_beam_size"] = None  # Fits fine

            logger.info(
                "Loading Whisper model: %s (device=%s, compute=%s%s)",
                settings.WHISPER_MODEL, device, compute_type,
                f", device_index={device_index}" if device == "cuda" else "",
            )
            try:
                _whisper_model = WhisperModel(
                    settings.WHISPER_MODEL,
                    **model_kwargs,
                )
            except Exception as e:
                if device == "cuda":
                    logger.warning(
                        "Failed to load Whisper on CUDA (%s, device_index=%d), falling back to CPU: %s",
                        gpu_name, device_index, e,
                    )
                    device = "cpu"
                    compute_type = "int8"
                    # Downgrade model for CPU — large models are too slow on CPU
                    if settings.WHISPER_MODEL in ("large-v3", "large-v3-turbo"):
                        settings.WHISPER_MODEL = "small"
                        logger.info("Downgraded Whisper model to 'small' for CPU fallback (large models too slow on CPU)")
                    whisper_device_info.update({"device": device, "compute_type": compute_type})
                    _whisper_model = WhisperModel(
                        settings.WHISPER_MODEL,
                        device=device,
                        compute_type=compute_type,
                    )
                else:
                    raise

            # ── Verify GPU is actually being used ──
            if device == "cuda":
                _verify_whisper_gpu_usage(gpu_name, device_index)
            else:
                logger.info(
                    "Whisper model '%s' loaded on CPU (int8) — GPU not used for transcription",
                    settings.WHISPER_MODEL,
                )

            _loaded_model_name = settings.WHISPER_MODEL
    return _whisper_model


def _verify_whisper_gpu_usage(gpu_name: str, device_index: int = 0):
    """Verify that the Whisper model is actually running on the GPU.

    Checks ctranslate2 and torch to confirm CUDA is active,
    providing definitive proof the GPU is in use.
    """
    verification_methods = []

    # Method 1: Check ctranslate2 CUDA device count (confirms CUDA runtime is active)
    try:
        import ctranslate2
        cuda_count = ctranslate2.get_cuda_device_count()
        if cuda_count > 0:
            verification_methods.append(f"ctranslate2 sees {cuda_count} CUDA device(s)")
    except Exception:
        pass

    # Method 2: Check PyTorch CUDA memory allocation (if torch is available)
    try:
        import torch
        if torch.cuda.is_available():
            mem_allocated = torch.cuda.memory_allocated(device_index)
            mem_reserved = torch.cuda.memory_reserved(device_index)
            if mem_allocated > 0 or mem_reserved > 0:
                verification_methods.append(
                    f"torch CUDA device {device_index}: "
                    f"{mem_allocated / 1024 / 1024:.1f}MB allocated, "
                    f"{mem_reserved / 1024 / 1024:.1f}MB reserved"
                )
            else:
                verification_methods.append(
                    f"torch CUDA device {device_index} available "
                    "(memory will allocate on first inference)"
                )
    except Exception:
        pass

    # Method 3: Check nvidia-smi for GPU processes
    try:
        import subprocess, os as _os
        smi = subprocess.run(
            ["nvidia-smi", "--query-compute-apps=pid,name,used_memory",
             "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=5,
        )
        if smi.returncode == 0 and smi.stdout.strip():
            our_pid = str(_os.getpid())
            for line in smi.stdout.strip().split("\n"):
                if our_pid in line:
                    verification_methods.append(f"nvidia-smi confirms GPU usage: {line.strip()}")
                    break
    except Exception:
        pass

    if verification_methods:
        logger.info(
            "GPU VERIFICATION for Whisper (device=%d, %s): CONFIRMED\n  - %s",
            device_index, gpu_name, "\n  - ".join(verification_methods),
        )
    else:
        logger.warning(
            "GPU VERIFICATION for Whisper (device=%d, %s): UNCONFIRMED — "
            "could not verify GPU memory allocation. Model loaded with device=cuda "
            "but GPU usage cannot be independently confirmed.",
            device_index, gpu_name,
        )


def preload_model():
    """Preload the Whisper model so the first transcription doesn't have to wait."""
    try:
        logger.info("Preloading Whisper model in background...")
        _get_whisper_model()

        # Log a summary of what GPU is used for each subsystem
        _wdev = whisper_device_info
        if _wdev["device"] == "cuda" and _wdev.get("gpu_name"):
            whisper_label = f"CUDA — {_wdev['gpu_name']} ({_wdev['compute_type']}, device {_wdev.get('device_index', 0)})"
        elif _wdev["device"] == "cuda":
            whisper_label = f"CUDA ({_wdev['compute_type']})"
        else:
            whisper_label = f"CPU ({_wdev['compute_type']})"

        try:
            from backend.services.clip_exporter import get_encoder_label
            encoder_label = get_encoder_label()
        except Exception:
            encoder_label = "unknown"

        logger.info("Whisper transcription: %s", whisper_label)
        logger.info("Video encoding: %s", encoder_label)
    except Exception as e:
        logger.warning(f"Whisper model preload failed (will retry on first use): {e}")


async def transcribe_audio(
    audio_path: str,
    language: str = "",
    task: str = "transcribe",
    initial_prompt: str = "",
    cancel_check: Optional[Callable] = None,
    progress_callback: Optional[Callable] = None,
    audio_duration: float = 0,
) -> list[TranscriptSegment]:
    """
    Transcribe audio using faster-whisper with live progress reporting.

    Args:
        audio_path: Path to the audio file.
        language: ISO 639-1 language code (e.g. "en", "es"). Empty = auto-detect.
        cancel_check: Optional callable that raises if the job was cancelled.
        progress_callback: Optional async callable(info_dict) for progress.
            info_dict keys: segments, pct, lang, position_sec, eta_sec, last_text
        audio_duration: Total audio duration in seconds (for progress estimation).
    """
    import asyncio
    import functools

    # Shared state for progress reporting from the sync thread
    progress_state = {
        "segments": 0,
        "latest_end": 0.0,
        "language": "",
        "last_text": "",
        "start_time": 0.0,
        "done": False,
    }
    lock = threading.Lock()

    loop = asyncio.get_running_loop()

    # Use the dedicated transcription executor so the Whisper thread is
    # never blocked behind base64-encoding or other default-pool tasks.
    future = loop.run_in_executor(
        _transcription_executor, functools.partial(
            _transcribe_sync, audio_path, language=language,
            task=task, initial_prompt=initial_prompt,
            progress_state=progress_state, progress_lock=lock,
        )
    )

    task = asyncio.ensure_future(future)
    last_reported = 0
    last_segment_time = time.monotonic()

    # Timeout: generous base + proportional to audio length
    # e.g. 10 min base + 3x audio duration (Whisper is typically ~1x real-time on CPU)
    max_timeout = _MODEL_LOAD_TIMEOUT + max(audio_duration * 3, 300)

    while not task.done():
        await asyncio.sleep(1.0)
        if not task.done():
            if cancel_check:
                cancel_check()

            # Detect stalls: if no new segment appears for _SEGMENT_STALL_TIMEOUT
            # seconds after at least one segment has been produced, and we're past
            # the model-loading phase, warn but keep waiting (model may be on a
            # long silence stretch).  If the overall timeout expires, we break out.
            with lock:
                seg_count = progress_state["segments"]
                done_flag = progress_state["done"]

            if seg_count > last_reported:
                last_segment_time = time.monotonic()

            # Overall timeout guard
            elapsed_total = time.monotonic() - (progress_state.get("start_time") or time.monotonic())
            if not done_flag and progress_state.get("start_time") and elapsed_total > max_timeout:
                logger.warning(
                    "Transcription timed out after %.0fs (audio=%.0fs). "
                    "Returning %d segments collected so far.",
                    elapsed_total, audio_duration, seg_count,
                )
                break

            # Report progress from the sync thread's shared state
            if progress_callback:
                with lock:
                    seg_count = progress_state["segments"]
                    latest_end = progress_state["latest_end"]
                    lang = progress_state["language"]
                    last_text = progress_state["last_text"]
                    start_time = progress_state["start_time"]
                if seg_count > last_reported:
                    last_reported = seg_count
                    pct = min(99, int((latest_end / audio_duration) * 100)) if audio_duration > 0 else 0
                    # Calculate ETA
                    eta_sec = 0
                    if pct > 0 and start_time > 0:
                        elapsed = time.monotonic() - start_time
                        eta_sec = max(0, (elapsed / (pct / 100)) * (1 - pct / 100))
                    await progress_callback({
                        "segments": seg_count,
                        "pct": pct,
                        "lang": lang,
                        "position_sec": latest_end,
                        "eta_sec": eta_sec,
                        "last_text": last_text,
                    })

    if task.done():
        try:
            return task.result()
        except Exception as e:
            # Whisper crashed mid-transcription (CUDA OOM, segfault, etc.)
            # Try to recover partial segments collected before the crash.
            with lock:
                partial = list(progress_state.get("raw_segments", []))
            if partial:
                logger.warning(
                    "Whisper crashed after %d segments (error: %s). "
                    "Returning partial transcription.",
                    len(partial), str(e)[:200],
                )
                partial = _filter_hallucinations(partial)
                if partial:
                    result_segs = []
                    for seg in partial:
                        words = None
                        if seg.get("words"):
                            words = [WordTimestamp(**w) for w in seg["words"]]
                        result_segs.append(TranscriptSegment(
                            start=round(seg["start"], 2),
                            end=round(seg["end"], 2),
                            text=seg["text"],
                            speaker="Speaker 1",
                            words=words,
                            confidence=seg.get("confidence"),
                            avg_logprob=seg.get("avg_logprob"),
                            no_speech_prob=seg.get("no_speech_prob"),
                        ))
                    _last_diarization_method["method"] = "deferred"
                    logger.info(
                        "Recovered %d segments covering %.1fs of audio",
                        len(result_segs),
                        result_segs[-1].end if result_segs else 0,
                    )
                    return result_segs
            logger.error("Whisper crashed with no recoverable segments: %s", str(e)[:200])
            raise

    # Timeout path: return whatever segments were collected so far.
    # The sync thread stores partial results in progress_state["raw_segments"].
    logger.warning("Returning partial transcription due to timeout")
    with lock:
        partial = list(progress_state.get("raw_segments", []))
    if partial:
        return _assign_speakers(partial)
    return []


def _chunk_audio(audio_path: str, chunk_duration: int = 600, overlap: int = 30) -> list[dict]:
    """Split audio into overlapping chunks for long-form transcription.

    Args:
        audio_path: Path to preprocessed audio file.
        chunk_duration: Duration of each chunk in seconds (default 10 minutes).
        overlap: Overlap between chunks in seconds (default 30s).

    Returns:
        List of {"path": str, "offset": float} dicts.
        For short audio (<= chunk_duration), returns single chunk with offset 0.
    """
    import subprocess, tempfile, os, json as _json

    probe = subprocess.run(
        ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", audio_path],
        capture_output=True, text=True, timeout=30,
    )
    duration = float(_json.loads(probe.stdout)["format"]["duration"])

    if duration <= chunk_duration:
        return [{"path": audio_path, "offset": 0.0}]

    chunks = []
    start = 0.0
    chunk_dir = tempfile.mkdtemp(prefix="whisper_chunks_")

    while start < duration:
        chunk_end = min(start + chunk_duration, duration)
        chunk_path = os.path.join(chunk_dir, f"chunk_{len(chunks):04d}.wav")

        cmd = [
            "ffmpeg", "-y", "-i", audio_path,
            "-ss", str(start),
            "-t", str(chunk_end - start),
            "-c:a", "pcm_s16le", "-ar", "16000", "-ac", "1",
            chunk_path,
        ]
        result = subprocess.run(cmd, capture_output=True, timeout=60)
        if result.returncode == 0:
            chunks.append({"path": chunk_path, "offset": start})
        else:
            logger.warning("Failed to create chunk at %.1fs: %s",
                           start, result.stderr[-200:] if result.stderr else "unknown")

        start += chunk_duration - overlap

    logger.info("Split %.0fs audio into %d chunks (%ds each, %ds overlap)",
                duration, len(chunks), chunk_duration, overlap)
    return chunks


def _merge_chunk_segments(all_chunks: list[list[dict]], overlap: int = 30) -> list[dict]:
    """Merge segments from overlapping audio chunks, deduplicating overlap regions."""
    if len(all_chunks) <= 1:
        return all_chunks[0] if all_chunks else []

    merged = list(all_chunks[0])

    for chunk_idx in range(1, len(all_chunks)):
        next_segments = all_chunks[chunk_idx]
        if not next_segments:
            continue
        if not merged:
            merged = list(next_segments)
            continue

        prev_last_end = merged[-1]["end"]
        next_first_start = next_segments[0]["start"]
        overlap_start = next_first_start
        overlap_end = prev_last_end

        if overlap_start >= overlap_end:
            merged.extend(next_segments)
            continue

        midpoint = (overlap_start + overlap_end) / 2.0

        # Trim prev chunk: remove segments that START after midpoint
        while merged and merged[-1]["start"] > midpoint:
            merged.pop()

        # Trim next chunk: skip segments that END before midpoint
        skip = 0
        for seg in next_segments:
            if seg["end"] < midpoint:
                skip += 1
            else:
                break

        merged.extend(next_segments[skip:])

    # Final pass: remove remaining timestamp overlaps
    deduped = []
    for seg in merged:
        if deduped and seg["start"] < deduped[-1]["end"] - 0.1:
            if seg.get("confidence", 0) > deduped[-1].get("confidence", 0):
                deduped[-1] = seg
        else:
            deduped.append(seg)

    return deduped


def _transcribe_sync(
    audio_path: str,
    language: str = "",
    task: str = "transcribe",
    initial_prompt: str = "",
    progress_state: Optional[dict] = None,
    progress_lock: Optional[threading.Lock] = None,
) -> list[TranscriptSegment]:
    model = _get_whisper_model()
    # Use VRAM-aware beam size if available (prevents silent CUDA OOM on ≤4GB GPUs)
    _recommended_beam = whisper_device_info.get("recommended_beam_size")
    effective_beam = _recommended_beam if _recommended_beam is not None else settings.WHISPER_BEAM_SIZE
    effective_best_of = 1 if effective_beam <= 1 else 3
    transcribe_kwargs = {
        "task": task,
        "beam_size": effective_beam,
        "best_of": effective_best_of,
        "vad_filter": settings.WHISPER_VAD_FILTER,
        "condition_on_previous_text": True,
        "word_timestamps": True,
        "no_speech_threshold": 0.6,
        "log_prob_threshold": -1.0,
        "compression_ratio_threshold": 2.4,
        "repetition_penalty": 1.1,
        "no_repeat_ngram_size": 3,           # Was 0 — prevents phrase-level repetition
        # Temperature fallback: if a segment fails quality checks at temp 0.0,
        # retry with progressively more randomness.
        "temperature": [0.0, 0.2, 0.4, 0.6, 0.8, 1.0],
        # Reset previous-text context when temp > 0.5 (failed segment).
        # Prevents hallucinated text from poisoning the next segment.
        "prompt_reset_on_temperature": 0.5,
    }
    if settings.WHISPER_VAD_FILTER:
        transcribe_kwargs["vad_parameters"] = {
            "min_silence_duration_ms": 300,   # Was 500 — shorter threshold preserves natural pauses
            "speech_pad_ms": 400,              # Was 200 — wider padding prevents clipping plosives
            "onset": 0.35,                     # Lower than default 0.5 — captures softer speech
            "min_speech_duration_ms": 100,     # Don't discard very short utterances
        }
    # CJK languages have higher natural compression ratios — relax threshold
    _is_cjk_hint = language.lower() in ("ja", "ko", "zh", "zh-cn", "zh-tw") if language else False
    if _is_cjk_hint:
        transcribe_kwargs["compression_ratio_threshold"] = 3.0

    if language:
        transcribe_kwargs["language"] = language
        logger.info(f"Transcribing with explicit language: {language}, task: {task}")
    else:
        logger.info(f"Transcribing with auto language detection, task: {task}")

    if initial_prompt:
        transcribe_kwargs["initial_prompt"] = initial_prompt
        logger.info(f"Using initial_prompt ({len(initial_prompt)} chars)")

    opts = (
        f"task={task}, beam={effective_beam}"
        f"{' (VRAM-reduced)' if _recommended_beam is not None else ''}, "
        f"best_of={effective_best_of}, "
        f"vad={'on' if settings.WHISPER_VAD_FILTER else 'off'}, "
        f"no_repeat_ngram=3, temp_fallback=6_steps"
    )
    logger.info(f"Whisper options: {opts}")

    # ── Audio preprocessing for accuracy ──
    # Normalize volume so Whisper gets consistent input levels.
    # Whisper was trained on -20 LUFS audio; quiet recordings or loud
    # ones with clipping both degrade accuracy.
    preprocessed_path = audio_path
    try:
        import subprocess
        import tempfile
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            preprocessed_path = tmp.name

        # Two-pass loudnorm for precise normalization
        # Pass 1: Measure loudness statistics
        measure_cmd = [
            "ffmpeg", "-y", "-i", audio_path,
            "-af", "highpass=f=50,loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json",
            "-f", "null", "-",
        ]
        measure_result = subprocess.run(measure_cmd, capture_output=True, text=True, timeout=120)

        loudnorm_stats = None
        if measure_result.returncode == 0 and measure_result.stderr:
            import json as _json
            stderr_text = measure_result.stderr
            json_start = stderr_text.rfind('{')
            json_end = stderr_text.rfind('}')
            if json_start >= 0 and json_end > json_start:
                try:
                    loudnorm_stats = _json.loads(stderr_text[json_start:json_end + 1])
                except (ValueError, KeyError):
                    pass

        if loudnorm_stats:
            # Pass 2: Apply measured corrections (precise normalization)
            measured_i = loudnorm_stats.get("input_i", "-24.0")
            measured_tp = loudnorm_stats.get("input_tp", "-2.0")
            measured_lra = loudnorm_stats.get("input_lra", "7.0")
            measured_thresh = loudnorm_stats.get("input_thresh", "-34.0")
            target_offset = loudnorm_stats.get("target_offset", "0.0")

            normalize_filter = (
                f"highpass=f=50,"
                f"loudnorm=I=-16:TP=-1.5:LRA=11:linear=true"
                f":measured_I={measured_i}:measured_TP={measured_tp}"
                f":measured_LRA={measured_lra}:measured_thresh={measured_thresh}"
                f":offset={target_offset}"
            )
            cmd = [
                "ffmpeg", "-y", "-i", audio_path,
                "-af", normalize_filter,
                "-ar", "16000", "-ac", "1",
                preprocessed_path,
            ]
            result = subprocess.run(cmd, capture_output=True, timeout=120)
            if result.returncode != 0:
                logger.warning("Two-pass loudnorm failed, falling back to single-pass")
                cmd_fallback = [
                    "ffmpeg", "-y", "-i", audio_path,
                    "-af", "highpass=f=50,loudnorm=I=-16:TP=-1.5:LRA=11",
                    "-ar", "16000", "-ac", "1",
                    preprocessed_path,
                ]
                subprocess.run(cmd_fallback, capture_output=True, timeout=120)
            else:
                logger.info("Audio preprocessed: two-pass loudnorm to -16 LUFS, 16kHz mono")
        else:
            # Fallback: single-pass if measurement failed
            cmd = [
                "ffmpeg", "-y", "-i", audio_path,
                "-af", "highpass=f=50,loudnorm=I=-16:TP=-1.5:LRA=11",
                "-ar", "16000", "-ac", "1",
                preprocessed_path,
            ]
            result = subprocess.run(cmd, capture_output=True, timeout=120)
            if result.returncode != 0:
                preprocessed_path = audio_path
            else:
                logger.info("Audio preprocessed: single-pass loudnorm (measurement failed)")
    except Exception as e:
        logger.warning("Audio preprocessing skipped: %s", e)
        preprocessed_path = audio_path

    # ── Validate preprocessed audio ──
    # If loudnorm produced a corrupt/empty file, fall back to the original.
    if preprocessed_path != audio_path:
        try:
            import os as _os
            file_size = _os.path.getsize(preprocessed_path)
            if file_size < 1000:  # WAV header alone is 44 bytes; <1KB = certainly empty
                logger.warning(
                    "Preprocessed audio is suspiciously small (%d bytes) — "
                    "falling back to original audio",
                    file_size,
                )
                preprocessed_path = audio_path
            else:
                import subprocess as _sp
                probe = _sp.run(
                    ["ffprobe", "-v", "error", "-select_streams", "a:0",
                     "-show_entries", "stream=duration,sample_rate,channels",
                     "-of", "csv=p=0", preprocessed_path],
                    capture_output=True, text=True, timeout=10,
                )
                if probe.returncode != 0 or not probe.stdout.strip():
                    logger.warning(
                        "Preprocessed audio has no valid audio stream — "
                        "falling back to original: %s",
                        (probe.stderr or "unknown error")[:200],
                    )
                    preprocessed_path = audio_path
                else:
                    logger.info(
                        "Preprocessed audio validated: %d bytes, %s",
                        file_size, probe.stdout.strip(),
                    )
        except Exception as val_err:
            logger.warning("Audio validation failed (%s) — using preprocessed file anyway", val_err)

    # ── Chunked transcription for long audio ──
    # Whisper's 30-second attention window causes accuracy degradation on long files.
    # Split into 10-min chunks with 30s overlap, then merge.
    chunks = _chunk_audio(preprocessed_path, chunk_duration=600, overlap=30)

    if len(chunks) > 1:
        logger.info("Using chunked transcription: %d chunks for long audio", len(chunks))
        all_chunk_segments: list[list[dict]] = []
        detected_lang = None

        wall_start = time.monotonic()
        if progress_state and progress_lock:
            with progress_lock:
                progress_state["start_time"] = wall_start

        for ci, chunk_info in enumerate(chunks):
            chunk_kwargs = dict(transcribe_kwargs)
            # For chunks after the first, use detected language (don't re-detect)
            if detected_lang and not language:
                chunk_kwargs["language"] = detected_lang

            try:
                chunk_segments_iter, chunk_info_obj = model.transcribe(
                    chunk_info["path"], **chunk_kwargs
                )
            except Exception as e:
                error_str = str(e).lower()
                if any(p in error_str for p in ["out of memory", "cuda", "cudamalloc", "oom"]):
                    logger.error(
                        "Whisper CUDA OOM during chunk %d/%d transcription "
                        "(model=%s, device=%s). Audio: %s",
                        ci + 1, len(chunks),
                        settings.WHISPER_MODEL, whisper_device_info.get("device", "?"),
                        chunk_info["path"],
                    )
                raise

            if ci == 0:
                detected_lang = chunk_info_obj.language
                _last_detected_language["lang"] = detected_lang
                logger.info("Detected language: %s (prob=%.2f)",
                            detected_lang, chunk_info_obj.language_probability)
                if progress_state and progress_lock:
                    with progress_lock:
                        progress_state["language"] = detected_lang

            chunk_raw = []
            try:
                for segment in chunk_segments_iter:
                    text = segment.text.strip()
                    word_list = None
                    if hasattr(segment, "words") and segment.words:
                        word_list = []
                        for w in segment.words:
                            word_text = w.word.strip()
                            if not word_text:
                                continue
                            # Skip phantom words with extremely low probability
                            word_prob = getattr(w, 'probability', 1.0)
                            if word_prob < 0.01:
                                logger.debug("Skipping low-probability word at %.2fs: '%s' (p=%.4f)",
                                             w.start + chunk_info["offset"], word_text, word_prob)
                                continue
                            word_list.append({
                                "start": round(w.start + chunk_info["offset"], 3),
                                "end": round(w.end + chunk_info["offset"], 3),
                                "word": word_text,
                            })

                    seg_end = segment.end + chunk_info["offset"]
                    seg_start = segment.start + chunk_info["offset"]
                    if word_list:
                        last_word_end = max(w["end"] for w in word_list)
                        if last_word_end > seg_end:
                            seg_end = last_word_end + 0.05

                    avg_lp = getattr(segment, 'avg_logprob', -1.0)
                    no_speech = getattr(segment, 'no_speech_prob', 0.0)
                    confidence = max(0.0, min(1.0, 1.0 + avg_lp))
                    if no_speech > 0.3:
                        confidence *= (1.0 - no_speech)

                    chunk_raw.append({
                        "start": seg_start,
                        "end": seg_end,
                        "text": text,
                        "words": word_list,
                        "confidence": round(confidence, 3),
                        "avg_logprob": round(avg_lp, 4) if avg_lp is not None else None,
                        "no_speech_prob": round(no_speech, 4) if no_speech is not None else None,
                    })
            except Exception as iter_err:
                error_str = str(iter_err).lower()
                is_oom = any(p in error_str for p in [
                    "out of memory", "cuda", "cudamalloc", "oom", "cublaslt",
                ])
                logger.error(
                    "Whisper %s during chunk %d/%d iteration "
                    "(model=%s, device=%s, beam=%d, collected %d segments before crash): %s",
                    "CUDA OOM" if is_oom else "error",
                    ci + 1, len(chunks),
                    settings.WHISPER_MODEL, whisper_device_info.get("device", "?"),
                    effective_beam, len(chunk_raw),
                    str(iter_err)[:300],
                )
                if is_oom:
                    logger.warning(
                        "Continuing with remaining chunks after CUDA OOM in chunk %d. "
                        "Collected %d segments from this chunk before failure.",
                        ci + 1, len(chunk_raw),
                    )
                else:
                    logger.warning(
                        "Non-CUDA error during chunk %d iteration — continuing with %d segments",
                        ci + 1, len(chunk_raw),
                    )

            all_chunk_segments.append(chunk_raw)

            # Update progress
            if progress_state and progress_lock:
                total_so_far = sum(len(c) for c in all_chunk_segments)
                last_end = chunk_raw[-1]["end"] if chunk_raw else 0
                with progress_lock:
                    progress_state["segments"] = total_so_far
                    progress_state["latest_end"] = last_end
                    progress_state["last_text"] = chunk_raw[-1]["text"][:80] if chunk_raw else ""
                    progress_state["language"] = detected_lang or ""
                    # Store flat list for partial recovery
                    progress_state["raw_segments"] = [
                        seg for chunk in all_chunk_segments for seg in chunk
                    ]

            if len(chunk_raw) == 0:
                _chunk_size = 0
                try:
                    import os as _os
                    _chunk_size = _os.path.getsize(chunk_info["path"])
                except Exception:
                    pass
                logger.warning(
                    "Chunk %d/%d: 0 SEGMENTS (offset=%.1fs, file=%s, size=%d bytes). "
                    "Possible causes: (1) CUDA OOM during beam search — reduce beam_size, "
                    "(2) audio chunk is silent/corrupt, (3) VAD filtered everything. "
                    "Model=%s, device=%s, beam=%d",
                    ci + 1, len(chunks), chunk_info["offset"],
                    chunk_info["path"], _chunk_size,
                    settings.WHISPER_MODEL, whisper_device_info.get("device", "?"),
                    effective_beam,
                )
            else:
                logger.info("Chunk %d/%d: %d segments (offset=%.1fs)",
                            ci + 1, len(chunks), len(chunk_raw), chunk_info["offset"])

        # Summary diagnostic: warn if most/all chunks produced nothing
        _empty_chunks = sum(1 for c in all_chunk_segments if len(c) == 0)
        _total_segs = sum(len(c) for c in all_chunk_segments)
        if _empty_chunks == len(all_chunk_segments):
            logger.error(
                "ALL %d chunks produced 0 segments (model=%s, device=%s, beam=%d). "
                "Whisper is completely failing on this audio. "
                "This is almost certainly a silent CUDA OOM — try beam_size=1 or CPU mode.",
                len(chunks), settings.WHISPER_MODEL,
                whisper_device_info.get("device", "?"), effective_beam,
            )
        elif _empty_chunks > 0:
            logger.warning(
                "%d/%d chunks produced 0 segments (%d total segments). "
                "Partial transcription — some chunks may have hit CUDA memory limits.",
                _empty_chunks, len(all_chunk_segments), _total_segs,
            )

        # Merge overlapping chunks
        raw_segments = _merge_chunk_segments(all_chunk_segments, overlap=30)

        # Cleanup chunk temp files
        import shutil, tempfile as _tmpmod
        chunk_dir = os.path.dirname(chunks[0]["path"]) if chunks[0]["path"] != preprocessed_path else None
        if chunk_dir and chunk_dir.startswith(_tmpmod.gettempdir()):
            shutil.rmtree(chunk_dir, ignore_errors=True)

        if progress_state and progress_lock:
            with progress_lock:
                progress_state["done"] = True
                progress_state["raw_segments"] = raw_segments
    else:
        # Original single-pass path for short audio
        try:
            segments_iter, info = model.transcribe(preprocessed_path, **transcribe_kwargs)
        except Exception as e:
            error_str = str(e).lower()
            if any(p in error_str for p in ["out of memory", "cuda", "cudamalloc", "oom"]):
                logger.error(
                    "Whisper CUDA OOM during transcription (model=%s, device=%s). "
                    "The model is too large for available VRAM. "
                    "Audio: %s, kwargs: beam=%s, best_of=%s",
                    settings.WHISPER_MODEL, whisper_device_info.get("device", "?"),
                    audio_path, transcribe_kwargs.get("beam_size"),
                    transcribe_kwargs.get("best_of"),
                )
            raise
        detected_lang = info.language
        _last_detected_language["lang"] = detected_lang
        logger.info(f"Detected language: {detected_lang} (prob={info.language_probability:.2f})")

        wall_start = time.monotonic()
        if progress_state and progress_lock:
            with progress_lock:
                progress_state["language"] = detected_lang
                progress_state["start_time"] = wall_start

        raw_segments = []
        try:
            for segment in segments_iter:
                text = segment.text.strip()
                word_list = None
                if hasattr(segment, "words") and segment.words:
                    word_list = []
                    for w in segment.words:
                        word_text = w.word.strip()
                        if not word_text:
                            continue
                        word_prob = getattr(w, 'probability', 1.0)
                        if word_prob < 0.01:
                            logger.debug("Skipping low-probability word at %.2fs: '%s' (p=%.4f)",
                                         w.start, word_text, word_prob)
                            continue
                        word_list.append({
                            "start": round(w.start, 3), "end": round(w.end, 3), "word": word_text,
                        })
                seg_end = segment.end
                if word_list:
                    last_word_end = max(w["end"] for w in word_list)
                    if last_word_end > seg_end:
                        seg_end = last_word_end + 0.05

                avg_lp = getattr(segment, 'avg_logprob', -1.0)
                no_speech = getattr(segment, 'no_speech_prob', 0.0)
                confidence = max(0.0, min(1.0, 1.0 + avg_lp))
                if no_speech > 0.3:
                    confidence *= (1.0 - no_speech)

                seg_dict = {
                    "start": segment.start,
                    "end": seg_end,
                    "text": text,
                    "words": word_list,
                    "confidence": round(confidence, 3),
                    "avg_logprob": round(avg_lp, 4) if avg_lp is not None else None,
                    "no_speech_prob": round(no_speech, 4) if no_speech is not None else None,
                }
                raw_segments.append(seg_dict)
                if progress_state and progress_lock:
                    with progress_lock:
                        progress_state["segments"] = len(raw_segments)
                        progress_state["latest_end"] = segment.end
                        progress_state["last_text"] = text[:80] if text else ""
                        progress_state["raw_segments"] = raw_segments
        except Exception as iter_err:
            error_str = str(iter_err).lower()
            is_oom = any(p in error_str for p in [
                "out of memory", "cuda", "cudamalloc", "oom", "cublaslt",
            ])
            logger.error(
                "Whisper %s during single-pass iteration "
                "(model=%s, device=%s, beam=%d, collected %d segments before crash): %s",
                "CUDA OOM" if is_oom else "error",
                settings.WHISPER_MODEL, whisper_device_info.get("device", "?"),
                effective_beam, len(raw_segments),
                str(iter_err)[:300],
            )

        if progress_state and progress_lock:
            with progress_lock:
                progress_state["done"] = True

    if not raw_segments:
        return []

    # Filter hallucinations before speaker assignment
    raw_segments = _filter_hallucinations(raw_segments)
    if not raw_segments:
        return []

    # ── Skip speaker diarization during initial transcription ──
    # All segments assigned to "Speaker 1" for maximum subtitle accuracy.
    # Diarization runs in post-processing when the user specifies speaker count
    # via POST /api/jobs/{job_id}/diarize — this gives the AI better guidance
    # and avoids diarization errors contaminating the initial transcript.
    transcript_segments = []
    for seg in raw_segments:
        words = None
        if seg.get("words"):
            words = [WordTimestamp(**w) for w in seg["words"]]
        transcript_segments.append(TranscriptSegment(
            start=round(seg["start"], 2),
            end=round(seg["end"], 2),
            text=seg["text"],
            speaker="Speaker 1",
            words=words,
            confidence=seg.get("confidence"),
            avg_logprob=seg.get("avg_logprob"),
            no_speech_prob=seg.get("no_speech_prob"),
        ))

    _last_diarization_method["method"] = "deferred"

    # Clean up preprocessed audio
    if preprocessed_path != audio_path:
        try:
            import os as _os
            _os.unlink(preprocessed_path)
        except OSError:
            pass

    logger.info(f"Transcription complete: {len(transcript_segments)} segments (diarization deferred to post)")
    return transcript_segments


def _extract_word_timestamps_sync(audio_path: str, language: str = "") -> list[WordTimestamp]:
    """Run Whisper with word_timestamps=True and return a flat sorted list of all words."""
    model = _get_whisper_model()
    kwargs = {
        "beam_size": settings.WHISPER_BEAM_SIZE,
        "best_of": 1,
        "vad_filter": settings.WHISPER_VAD_FILTER,
        "condition_on_previous_text": False,
        "word_timestamps": True,
    }
    if settings.WHISPER_VAD_FILTER:
        kwargs["vad_parameters"] = {
            "min_silence_duration_ms": 300,
            "speech_pad_ms": 400,
            "onset": 0.35,
            "min_speech_duration_ms": 100,
        }
    if language:
        kwargs["language"] = language

    segments_iter, _info = model.transcribe(audio_path, **kwargs)
    all_words: list[WordTimestamp] = []
    for segment in segments_iter:
        if hasattr(segment, "words") and segment.words:
            for w in segment.words:
                word_text = w.word.strip()
                if word_text:
                    all_words.append(WordTimestamp(
                        start=round(w.start, 3),
                        end=round(w.end, 3),
                        word=word_text,
                    ))
    all_words.sort(key=lambda w: w.start)
    return all_words


async def extract_word_timestamps(
    audio_path: str,
    language: str = "",
) -> list[WordTimestamp]:
    """Async wrapper: extract word-level timestamps from audio using Whisper."""
    import asyncio
    import functools

    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(
        _transcription_executor,
        functools.partial(_extract_word_timestamps_sync, audio_path, language=language),
    )


def _assign_speakers(raw_segments: list[dict]) -> list[TranscriptSegment]:
    """Assign speaker labels using enhanced pause-based turn detection.

    Caps speakers at MAX_HEURISTIC_SPEAKERS to avoid absurd counts (e.g. 34).
    Tracks speaker history and speech rate per speaker to make smarter toggle
    decisions for 3+ person conversations.
    """
    MAX_HEURISTIC_SPEAKERS = max(
        2,
        settings.DIARIZATION_MAX_SPEAKERS if settings.DIARIZATION_MAX_SPEAKERS > 0 else 8,
    )
    TURN_GAP = 1.2
    NEW_SPEAKER_GAP = 5.0
    MONOLOGUE_DURATION = 15.0
    INTERJECTION_WORDS = 4
    RATE_CHANGE_THRESHOLD = 0.4

    if not raw_segments:
        return []

    transcript_segments = []
    current_speaker = 1
    speakers_seen = 1
    speaker_history: list[int] = [1]
    speaker_rates: dict[int, list[float]] = {1: []}

    def _words_per_sec(seg: dict) -> float:
        duration = seg["end"] - seg["start"]
        if duration <= 0:
            return 3.0
        word_count = len(seg["text"].split()) if seg["text"] else 0
        return word_count / duration if duration > 0.5 else 3.0

    def _avg_rate(speaker: int) -> float:
        rates = speaker_rates.get(speaker, [])
        return sum(rates) / len(rates) if rates else 3.0

    def _most_likely_existing_speaker(rate: float) -> int:
        best_speaker = current_speaker
        best_diff = float('inf')
        for sp, rates in speaker_rates.items():
            if not rates:
                continue
            avg = sum(rates) / len(rates)
            diff = abs(avg - rate)
            if diff < best_diff:
                best_diff = diff
                best_speaker = sp
        return best_speaker

    for i, seg in enumerate(raw_segments):
        seg_rate = _words_per_sec(seg)
        seg_word_count = len(seg["text"].split()) if seg["text"] else 0

        if i > 0:
            gap = seg["start"] - raw_segments[i - 1]["end"]
            prev_duration = raw_segments[i - 1]["end"] - raw_segments[i - 1]["start"]
            prev_rate = _words_per_sec(raw_segments[i - 1])

            if gap >= NEW_SPEAKER_GAP:
                rate_match = _most_likely_existing_speaker(seg_rate)
                rate_diff = abs(seg_rate - _avg_rate(rate_match))
                if rate_diff < RATE_CHANGE_THRESHOLD and rate_match != current_speaker:
                    current_speaker = rate_match
                elif speakers_seen < MAX_HEURISTIC_SPEAKERS:
                    speakers_seen += 1
                    current_speaker = speakers_seen
                else:
                    current_speaker = _most_likely_existing_speaker(seg_rate)
            elif gap >= TURN_GAP:
                other = None
                for sp in reversed(speaker_history):
                    if sp != current_speaker:
                        other = sp
                        break
                if other:
                    current_speaker = other
                elif speakers_seen < MAX_HEURISTIC_SPEAKERS:
                    speakers_seen += 1
                    current_speaker = speakers_seen
                else:
                    current_speaker = _most_likely_existing_speaker(seg_rate)
            elif (prev_duration > MONOLOGUE_DURATION
                  and seg_word_count <= INTERJECTION_WORDS and gap < 0.5):
                other = None
                for sp in reversed(speaker_history):
                    if sp != current_speaker:
                        other = sp
                        break
                if other:
                    current_speaker = other
                elif speakers_seen < MAX_HEURISTIC_SPEAKERS:
                    speakers_seen += 1
                    current_speaker = speakers_seen
                else:
                    current_speaker = _most_likely_existing_speaker(seg_rate)
            elif abs(seg_rate - prev_rate) > RATE_CHANGE_THRESHOLD * max(seg_rate, prev_rate, 0.1):
                rate_match = _most_likely_existing_speaker(seg_rate)
                if rate_match != current_speaker:
                    current_speaker = rate_match

        speaker_history.append(current_speaker)
        if len(speaker_history) > 20:
            speaker_history = speaker_history[-20:]

        if current_speaker not in speaker_rates:
            speaker_rates[current_speaker] = []
        speaker_rates[current_speaker].append(seg_rate)
        if len(speaker_rates[current_speaker]) > 10:
            speaker_rates[current_speaker] = speaker_rates[current_speaker][-10:]

        words = None
        if seg.get("words"):
            words = [WordTimestamp(**w) for w in seg["words"]]

        transcript_segments.append(TranscriptSegment(
            start=round(seg["start"], 2),
            end=round(seg["end"], 2),
            text=seg["text"],
            speaker=f"Speaker {current_speaker}",
            words=words,
            confidence=seg.get("confidence"),
            avg_logprob=seg.get("avg_logprob"),
            no_speech_prob=seg.get("no_speech_prob"),
        ))

    return transcript_segments


_WHISPER_BOILERPLATE = {
    "thank you for watching",
    "thanks for watching",
    "please subscribe",
    "like and subscribe",
    "don't forget to subscribe",
    "see you in the next video",
    "bye bye",
    "thanks for listening",
    "music playing",
    "music",
    "applause",
    "subtitles by",
    "captions by",
}


def _filter_hallucinations(raw_segments: list[dict]) -> list[dict]:
    """Remove Whisper hallucination segments.

    Detects and filters:
    - Non-speech segments (high no_speech_prob + low confidence)
    - Whisper boilerplate phrases
    - Backward-jumping timestamps (temporal ordering violations)
    - Abnormally long single segments (>1500 chars = likely runaway)
    - Repeated n-grams (looping text like "Thank you. Thank you. Thank you.")
    - Segments that are near-exact duplicates of the previous segment (sequence-based)
    """
    if not raw_segments:
        return raw_segments

    filtered = []
    prev_text = ""

    for seg in raw_segments:
        text = seg["text"].strip()

        # Skip empty segments
        if not text:
            continue

        # Check 0a: Non-speech segment (silence/music hallucination)
        no_speech = seg.get("no_speech_prob", 0.0)
        confidence = seg.get("confidence", 1.0)
        if no_speech and no_speech > 0.85 and confidence is not None and confidence < 0.15:
            logger.warning(
                "Hallucination filter: removed non-speech segment at %.1fs (no_speech=%.2f, conf=%.2f): %s...",
                seg["start"], no_speech, confidence, text[:60],
            )
            continue

        # Check 0b: Whisper boilerplate phrases — only at transcript edges with low confidence
        boilerplate_text = text.lower().strip().rstrip('.!')
        if boilerplate_text in _WHISPER_BOILERPLATE:
            is_edge = (not filtered) or (seg is raw_segments[-1]) or (
                len(raw_segments) > 1 and seg is raw_segments[-2])
            is_low_conf = confidence is not None and confidence < 0.5
            if is_edge and is_low_conf:
                logger.warning(
                    "Hallucination filter: removed boilerplate at %.1fs: %s",
                    seg["start"], text[:60],
                )
                continue

        # Check 0c: Temporal ordering — segment start must not jump backward
        if filtered and seg["start"] < filtered[-1]["start"]:
            logger.warning(
                "Hallucination filter: removed backward-jumping segment at %.1fs (prev started %.1fs): %s...",
                seg["start"], filtered[-1]["start"], text[:60],
            )
            continue

        # Check 1: Abnormally long segment (Whisper runaway)
        if len(text) > 1500:
            logger.warning(
                "Hallucination filter: removed runaway segment at %.1fs (%d chars): %s...",
                seg["start"], len(text), text[:80],
            )
            continue

        # Check 2: Repeated n-grams
        # For CJK languages (no spaces between words), use character-level n-grams
        # For space-delimited languages, use word-level trigrams
        _CJK_RANGES = (
            ('\u4e00', '\u9fff'),   # CJK Unified Ideographs
            ('\u3040', '\u309f'),   # Hiragana
            ('\u30a0', '\u30ff'),   # Katakana
            ('\uac00', '\ud7af'),   # Hangul Syllables
        )
        is_cjk = any(
            any(lo <= ch <= hi for lo, hi in _CJK_RANGES)
            for ch in text[:50]
        )

        if is_cjk:
            # Character-level n-gram detection for CJK
            chars = text.replace(" ", "")
            ngram_size = 6
            if len(chars) >= ngram_size * 3:
                ngrams = [chars[i:i+ngram_size] for i in range(len(chars) - ngram_size + 1)]
                ngram_counts: dict[str, int] = {}
                for ng in ngrams:
                    ngram_counts[ng] = ngram_counts.get(ng, 0) + 1
                max_repeat = max(ngram_counts.values()) if ngram_counts else 0
                if max_repeat >= 3 and max_repeat / len(ngrams) > 0.3:
                    logger.warning(
                        "Hallucination filter: removed CJK looping segment at %.1fs: %s...",
                        seg["start"], text[:80],
                    )
                    continue
        else:
            # Word-level trigram detection for space-delimited languages
            words = text.lower().split()
            if len(words) >= 9:
                trigrams = [tuple(words[i:i+3]) for i in range(len(words) - 2)]
                trigram_counts_w: dict[tuple, int] = {}
                for tg in trigrams:
                    trigram_counts_w[tg] = trigram_counts_w.get(tg, 0) + 1
                max_repeat = max(trigram_counts_w.values()) if trigram_counts_w else 0
                if max_repeat >= 3 and max_repeat / len(trigrams) > 0.4:
                    logger.warning(
                        "Hallucination filter: removed looping segment at %.1fs: %s...",
                        seg["start"], text[:80],
                    )
                    continue

        # Check 3: Near-duplicate of previous segment (sequence-based)
        if prev_text and text and len(text.split()) > 3:
            from difflib import SequenceMatcher
            ratio = SequenceMatcher(None, prev_text.lower(), text.lower()).ratio()
            seg_duration = seg["end"] - seg["start"]
            # Only filter near-identical duplicates at nearly the same timestamp
            # (0.85 was catching legitimate repeated phrases like "let's go, let's go")
            if ratio > 0.92 and seg_duration < 3.0 and abs(seg["start"] - filtered[-1]["start"]) < 2.0:
                logger.warning(
                    "Hallucination filter: removed duplicate segment at %.1fs (%.0f%% similar): %s...",
                    seg["start"], ratio * 100, text[:60],
                )
                continue

        filtered.append(seg)
        prev_text = text

    removed = len(raw_segments) - len(filtered)
    if removed > 0:
        logger.info("Hallucination filter: removed %d/%d segments", removed, len(raw_segments))
    return filtered


# ── Speaker Diarization (pyannote) ─────────────────────────────────────

_diarization_pipeline = None
_diarization_lock = threading.Lock()


def _get_diarization_pipeline():
    """Load pyannote speaker diarization pipeline (lazy init)."""
    global _diarization_pipeline
    with _diarization_lock:
        if _diarization_pipeline is None:
            try:
                from pyannote.audio import Pipeline
                token = settings.HF_AUTH_TOKEN
                if not token:
                    logger.warning(
                        "HF_AUTH_TOKEN not set — pyannote diarization unavailable. "
                        "Falling back to pause-based speaker detection."
                    )
                    return None
                _diarization_pipeline = Pipeline.from_pretrained(
                    "pyannote/speaker-diarization-3.1",
                    token=token,
                )
                # Move to GPU if available
                import torch
                if torch.cuda.is_available():
                    _diarization_pipeline.to(torch.device("cuda"))
                    logger.info("pyannote diarization loaded on CUDA")
                else:
                    logger.info("pyannote diarization loaded on CPU")
            except Exception as e:
                logger.warning("Failed to load pyannote diarization: %s", e)
                return None
    return _diarization_pipeline


def _diarize_audio(audio_path: str):
    """Run speaker diarization and return a mapping of (start, end) → speaker_label."""
    if not settings.DIARIZATION_ENABLED:
        return None

    pipeline = _get_diarization_pipeline()
    if pipeline is None:
        return None

    try:
        max_spk = settings.DIARIZATION_MAX_SPEAKERS if settings.DIARIZATION_MAX_SPEAKERS > 0 else None
        diarization = pipeline(
            audio_path,
            min_speakers=settings.DIARIZATION_MIN_SPEAKERS,
            max_speakers=max_spk,
        )

        # Build time-to-speaker mapping
        speaker_map = {}
        for turn, _, speaker in diarization.itertracks(yield_label=True):
            speaker_map[(turn.start, turn.end)] = speaker

        logger.info(
            "Diarization complete: %d turns, %d speakers",
            len(speaker_map),
            len(set(speaker_map.values())),
        )
        return speaker_map

    except Exception as e:
        logger.warning("Diarization failed: %s — falling back to pause-based", e)
        return None


async def diarize_transcript_post(
    audio_path: str,
    segments: list[TranscriptSegment],
    num_speakers: int = 0,
) -> list[TranscriptSegment]:
    """Run speaker diarization on an existing transcript (post-processing).

    Called when the user requests diarization after reviewing the transcript.
    The user can specify the exact number of speakers for better accuracy.

    Args:
        audio_path: Path to the audio file (for pyannote analysis).
        segments: Existing transcript segments (all "Speaker 1").
        num_speakers: Expected number of speakers (0 = auto-detect).

    Returns:
        Updated TranscriptSegment[] with speaker labels assigned.
    """
    import asyncio
    import functools

    # Convert segments to raw_segments format for speaker assignment
    raw_segments = []
    for seg in segments:
        word_list = None
        if seg.words:
            word_list = [{"start": w.start, "end": w.end, "word": w.word} for w in seg.words]
        raw_segments.append({
            "start": seg.start,
            "end": seg.end,
            "text": seg.text,
            "words": word_list,
            "confidence": seg.confidence,
            "avg_logprob": seg.avg_logprob,
            "no_speech_prob": seg.no_speech_prob,
        })

    # Try pyannote first (best quality)
    if settings.DIARIZATION_ENABLED and settings.HF_AUTH_TOKEN:
        pipeline = _get_diarization_pipeline()
        if pipeline:
            try:
                loop = asyncio.get_running_loop()

                def _run_pyannote():
                    diarize_kwargs = {"audio": audio_path}
                    if num_speakers > 0:
                        diarize_kwargs["min_speakers"] = num_speakers
                        diarize_kwargs["max_speakers"] = num_speakers
                    elif settings.DIARIZATION_MIN_SPEAKERS > 1:
                        diarize_kwargs["min_speakers"] = settings.DIARIZATION_MIN_SPEAKERS
                    if settings.DIARIZATION_MAX_SPEAKERS > 0 and num_speakers == 0:
                        diarize_kwargs["max_speakers"] = settings.DIARIZATION_MAX_SPEAKERS

                    diarization = pipeline(**diarize_kwargs)
                    speaker_map = {}
                    for turn, _, speaker in diarization.itertracks(yield_label=True):
                        speaker_map[(turn.start, turn.end)] = speaker
                    return speaker_map

                speaker_map = await loop.run_in_executor(_transcription_executor, _run_pyannote)

                if speaker_map:
                    result = _assign_speakers_from_diarization(raw_segments, speaker_map)
                    num_detected = len(set(s.speaker for s in result))
                    logger.info(
                        "Post-processing diarization (pyannote): %d speakers detected "
                        "(requested: %s)",
                        num_detected, num_speakers if num_speakers > 0 else "auto",
                    )
                    return result
            except Exception as e:
                logger.warning("Post-processing pyannote diarization failed: %s", e)

    # Fallback: heuristic speaker assignment
    result = _assign_speakers(raw_segments)
    num_detected = len(set(s.speaker for s in result))
    logger.info(
        "Post-processing diarization (heuristic): %d speakers detected "
        "(requested: %s)",
        num_detected, num_speakers if num_speakers > 0 else "auto",
    )
    return result


def _assign_speakers_from_diarization(
    raw_segments: list[dict], speaker_map: dict
) -> list[TranscriptSegment]:
    """Align Whisper segments with pyannote diarization output.

    Speakers are numbered by order of first appearance in the audio
    (not alphabetically by pyannote's internal SPEAKER_XX labels).
    """
    # Sort diarization turns by start time
    turns = sorted(speaker_map.items(), key=lambda x: x[0][0])

    # Build speaker name mapping by first-appearance order
    seen_order: list[str] = []
    for (_, _), speaker in turns:
        if speaker not in seen_order:
            seen_order.append(speaker)
    speaker_names = {s: f"Speaker {i+1}" for i, s in enumerate(seen_order)}

    transcript_segments = []
    for seg in raw_segments:
        seg_start, seg_end = seg["start"], seg["end"]

        # Find the turn with maximum overlap
        best_speaker = None
        best_overlap = 0.0
        for (turn_start, turn_end), speaker in turns:
            overlap_start = max(seg_start, turn_start)
            overlap_end = min(seg_end, turn_end)
            overlap = max(0.0, overlap_end - overlap_start)
            if overlap > best_overlap:
                best_overlap = overlap
                best_speaker = speaker

        speaker_label = speaker_names.get(best_speaker, "Speaker 1") if best_speaker else "Speaker 1"

        words = None
        if seg.get("words"):
            words = [WordTimestamp(**w) for w in seg["words"]]

        transcript_segments.append(TranscriptSegment(
            start=round(seg["start"], 2),
            end=round(seg["end"], 2),
            text=seg["text"],
            speaker=speaker_label,
            words=words,
            confidence=seg.get("confidence"),
            avg_logprob=seg.get("avg_logprob"),
            no_speech_prob=seg.get("no_speech_prob"),
        ))

    return transcript_segments
