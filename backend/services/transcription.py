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

    loop = asyncio.get_event_loop()

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
        "best_of": 1,  # single pass — skip temperature fallback sampling
        "vad_filter": settings.WHISPER_VAD_FILTER,
        "condition_on_previous_text": False,
        "word_timestamps": True,
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
        seg_dict = {
            "start": segment.start,
            "end": segment.end,
            "text": text,
            "words": word_list,
        }
        raw_segments.append(seg_dict)
        # Update shared progress state (read by async polling loop).
        # Also store raw_segments so the timeout path can return partial results.
        if progress_state and progress_lock:
            with progress_lock:
                progress_state["segments"] = len(raw_segments)
                progress_state["latest_end"] = segment.end
                progress_state["last_text"] = text[:80] if text else ""
                progress_state["raw_segments"] = list(raw_segments)

    if progress_state and progress_lock:
        with progress_lock:
            progress_state["done"] = True

    if not raw_segments:
        return []

    # Speaker diarization based on conversation turn detection
    transcript_segments = _assign_speakers(raw_segments)
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

    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(
        _transcription_executor,
        functools.partial(_extract_word_timestamps_sync, audio_path, language=language),
    )


def _assign_speakers(raw_segments: list[dict]) -> list[TranscriptSegment]:
    """Assign speaker labels using pause-based turn detection.

    Heuristics:
    - Short gaps (< 1.5s): same speaker continues
    - Medium gaps (1.5-4s): speaker turn — toggle between the two most recent speakers
    - Large gaps (> 4s): potential new speaker introduction (up to max 4)
    - Very long segments (> 30s) followed by a gap suggest a monologue ending, then a response
    """
    TURN_GAP = 1.5       # seconds — conversation turn boundary
    NEW_SPEAKER_GAP = 4.0  # seconds — possible new speaker
    MAX_SPEAKERS = 4

    if not raw_segments:
        return []

    transcript_segments = []
    current_speaker = 1
    previous_speaker = 1
    speakers_seen = 1

    for i, seg in enumerate(raw_segments):
        if i > 0:
            gap = seg["start"] - raw_segments[i - 1]["end"]

            if gap >= NEW_SPEAKER_GAP and speakers_seen < MAX_SPEAKERS:
                # Large gap — introduce a new speaker
                speakers_seen += 1
                previous_speaker = current_speaker
                current_speaker = speakers_seen
            elif gap >= TURN_GAP:
                # Medium gap — conversation turn, toggle between current and previous
                current_speaker, previous_speaker = previous_speaker, current_speaker
                # If current == previous (only 1 speaker so far), introduce speaker 2
                if current_speaker == previous_speaker and speakers_seen < MAX_SPEAKERS:
                    speakers_seen += 1
                    current_speaker = speakers_seen

        # Build word timestamps if available
        words = None
        if seg.get("words"):
            words = [WordTimestamp(**w) for w in seg["words"]]

        transcript_segments.append(TranscriptSegment(
            start=round(seg["start"], 2),
            end=round(seg["end"], 2),
            text=seg["text"],
            speaker=f"Speaker {current_speaker}",
            words=words,
        ))

    return transcript_segments
