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


def _get_whisper_model():
    global _whisper_model
    with _model_lock:
        if _whisper_model is None:
            from faster_whisper import WhisperModel
            import ctranslate2

            # Pick best device and compute type automatically
            device = "cpu"
            compute_type = "int8"
            try:
                if ctranslate2.get_cuda_device_count() > 0:
                    device = "cuda"
                    compute_type = "float16"
                    logger.info("CUDA GPU detected — using float16 for Whisper")
            except Exception:
                pass

            logger.info(
                f"Loading Whisper model: {settings.WHISPER_MODEL} "
                f"(device={device}, compute={compute_type})"
            )
            _whisper_model = WhisperModel(
                settings.WHISPER_MODEL,
                device=device,
                compute_type=compute_type,
            )
            logger.info(f"Whisper model '{settings.WHISPER_MODEL}' loaded successfully")
    return _whisper_model


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
