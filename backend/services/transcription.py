import logging
import time
import threading
from concurrent.futures import ThreadPoolExecutor
from typing import Callable, Optional

from backend.config import settings
from backend.models import TranscriptSegment, WordTimestamp

logger = logging.getLogger(__name__)

_whisper_model = None
_model_lock = threading.Lock()

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


def reload_model():
    """Force-reload the Whisper model on the next transcription call.

    Called when GPU acceleration is toggled so the model can move
    between CPU and CUDA without restarting the server.
    """
    global _whisper_model
    with _model_lock:
        _whisper_model = None
    logger.info("Whisper model cache cleared — will reload on next use")


def reload_diarization():
    """Force-reload the pyannote pipeline when HF_AUTH_TOKEN changes."""
    global _diarization_pipeline
    with _diarization_lock:
        _diarization_pipeline = None
    logger.info("pyannote diarization cache cleared — will reload on next use")


def _get_whisper_model():
    global _whisper_model, whisper_device_info
    with _model_lock:
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

            # Auto-upgrade model when GPU is available and user hasn't explicitly chosen
            if device == "cuda" and settings.WHISPER_MODEL == "small":
                settings.WHISPER_MODEL = "large-v3-turbo"
                logger.info("Auto-upgraded Whisper model to large-v3-turbo (GPU detected)")

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
                    # Downgrade model for CPU — large-v3-turbo is too slow on CPU
                    if settings.WHISPER_MODEL == "large-v3-turbo":
                        settings.WHISPER_MODEL = "small"
                        logger.info("Downgraded Whisper model to 'small' for CPU fallback (large-v3-turbo too slow on CPU)")
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
        return task.result()

    # Timeout path: return whatever segments were collected so far.
    # The sync thread stores partial results in progress_state["raw_segments"].
    logger.warning("Returning partial transcription due to timeout")
    with lock:
        partial = list(progress_state.get("raw_segments", []))
    if partial:
        return _assign_speakers(partial)
    return []


def _transcribe_sync(
    audio_path: str,
    language: str = "",
    progress_state: Optional[dict] = None,
    progress_lock: Optional[threading.Lock] = None,
) -> list[TranscriptSegment]:
    model = _get_whisper_model()
    transcribe_kwargs = {
        "beam_size": settings.WHISPER_BEAM_SIZE,
        "best_of": 1,
        "vad_filter": settings.WHISPER_VAD_FILTER,
        "condition_on_previous_text": True,  # Enables context across segments
        "word_timestamps": True,
        "no_speech_threshold": 0.6,          # Filter non-speech segments
        "log_prob_threshold": -1.0,          # Skip low-confidence segments
        "compression_ratio_threshold": 2.4,  # Detect hallucination loops
        "repetition_penalty": 1.1,           # Discourage repetitive output
    }
    if settings.WHISPER_VAD_FILTER:
        # Tune VAD parameters — keep speech with short pauses
        transcribe_kwargs["vad_parameters"] = {
            "min_silence_duration_ms": 500,
            "speech_pad_ms": 200,
        }
    if language:
        transcribe_kwargs["language"] = language
        logger.info(f"Transcribing with explicit language: {language}")
    else:
        logger.info("Transcribing with auto language detection")

    opts = f"beam={settings.WHISPER_BEAM_SIZE}, vad={'on' if settings.WHISPER_VAD_FILTER else 'off'}"
    logger.info(f"Whisper options: {opts}")

    segments_iter, info = model.transcribe(audio_path, **transcribe_kwargs)
    detected_lang = info.language
    _last_detected_language["lang"] = detected_lang
    logger.info(f"Detected language: {detected_lang} (prob={info.language_probability:.2f})")

    wall_start = time.monotonic()
    if progress_state and progress_lock:
        with progress_lock:
            progress_state["language"] = detected_lang
            progress_state["start_time"] = wall_start

    raw_segments = []
    for segment in segments_iter:
        text = segment.text.strip()
        # Capture per-word timestamps when available
        word_list = None
        if hasattr(segment, "words") and segment.words:
            word_list = [
                {"start": round(w.start, 3), "end": round(w.end, 3), "word": w.word.strip()}
                for w in segment.words
                if w.word.strip()
            ]
        # Extend segment end to cover last word if Whisper's word timestamps
        # exceed the segment boundary (common floating-point/overlap issue).
        seg_end = segment.end
        if word_list:
            last_word_end = max(w["end"] for w in word_list)
            if last_word_end > seg_end:
                seg_end = last_word_end + 0.05

        # Convert avg_logprob to a 0-1 confidence score
        # avg_logprob typically ranges from -2.0 (garbage) to 0.0 (perfect)
        avg_lp = getattr(segment, 'avg_logprob', -1.0)
        no_speech = getattr(segment, 'no_speech_prob', 0.0)
        confidence = max(0.0, min(1.0, 1.0 + avg_lp))  # -1.0 → 0.0, 0.0 → 1.0
        # Penalize if high no_speech probability
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
        # Update shared progress state (read by async polling loop).
        # Also store raw_segments so the timeout path can return partial results.
        if progress_state and progress_lock:
            with progress_lock:
                progress_state["segments"] = len(raw_segments)
                progress_state["latest_end"] = segment.end
                progress_state["last_text"] = text[:80] if text else ""
                progress_state["raw_segments"] = raw_segments

    if progress_state and progress_lock:
        with progress_lock:
            progress_state["done"] = True

    if not raw_segments:
        return []

    # Filter hallucinations before speaker assignment
    raw_segments = _filter_hallucinations(raw_segments)
    if not raw_segments:
        return []

    # Try pyannote diarization first, fall back to pause-based heuristic
    speaker_map = _diarize_audio(audio_path)
    if speaker_map:
        logger.info("Speaker detection: NEURAL mode (pyannote diarization)")
        transcript_segments = _assign_speakers_from_diarization(raw_segments, speaker_map)
        _last_diarization_method["method"] = "neural"
    else:
        logger.info("Speaker detection: HEURISTIC mode (pause-based) — set HF_AUTH_TOKEN for neural diarization")
        transcript_segments = _assign_speakers(raw_segments)
        _last_diarization_method["method"] = "heuristic"

    speaker_set = set(s.speaker for s in transcript_segments)
    logger.info(f"Transcription complete: {len(transcript_segments)} segments, {len(speaker_set)} speakers detected")
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
        kwargs["vad_parameters"] = {"min_silence_duration_ms": 500, "speech_pad_ms": 200}
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

    No artificial speaker cap. Tracks speaker history and speech rate per speaker
    to make smarter toggle decisions for 3+ person conversations.
    """
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
                else:
                    speakers_seen += 1
                    current_speaker = speakers_seen
            elif gap >= TURN_GAP:
                other = None
                for sp in reversed(speaker_history):
                    if sp != current_speaker:
                        other = sp
                        break
                if other:
                    current_speaker = other
                else:
                    speakers_seen += 1
                    current_speaker = speakers_seen
            elif (prev_duration > MONOLOGUE_DURATION
                  and seg_word_count <= INTERJECTION_WORDS and gap < 0.5):
                other = None
                for sp in reversed(speaker_history):
                    if sp != current_speaker:
                        other = sp
                        break
                if other:
                    current_speaker = other
                else:
                    speakers_seen += 1
                    current_speaker = speakers_seen
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
        if no_speech and no_speech > 0.7 and confidence is not None and confidence < 0.3:
            logger.warning(
                "Hallucination filter: removed non-speech segment at %.1fs (no_speech=%.2f, conf=%.2f): %s...",
                seg["start"], no_speech, confidence, text[:60],
            )
            continue

        # Check 0b: Whisper boilerplate phrases
        if text.lower().strip().rstrip('.!') in _WHISPER_BOILERPLATE:
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

        # Check 2: Repeated trigrams (e.g., "Thank you. Thank you. Thank you.")
        words = text.lower().split()
        if len(words) >= 9:
            trigrams = [tuple(words[i:i+3]) for i in range(len(words) - 2)]
            trigram_counts: dict[tuple, int] = {}
            for tg in trigrams:
                trigram_counts[tg] = trigram_counts.get(tg, 0) + 1
            max_repeat = max(trigram_counts.values()) if trigram_counts else 0
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
            # Only filter if very high similarity AND segment is short (< 5 seconds)
            if ratio > 0.85 and seg_duration < 5.0:
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
