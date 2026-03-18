import asyncio
import logging
import os
import shutil
import time as _time
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from backend.config import settings
from backend.models import JobResult, JobStatus, FrameData, VideoSummary
from backend import database
from backend.services.frame_extractor import (
    get_video_metadata,
    extract_frames,
    extract_audio,
    frame_to_base64,
)
from backend.services.transcription import transcribe_audio
from backend.services.ai_orchestrator import AIOrchestrator
from backend.services.prompts import load_prompts
from backend.services.providers.base import build_summary_from_transcript, has_real_summary_content, AllProvidersFailedError
from backend.services.audio_analyzer import analyze_audio_energy, format_audio_energy_map
from backend.services.clip_boundary_snapper import snap_all_clips

logger = logging.getLogger(__name__)

# Dedicated thread pool for base64 frame encoding so it never competes
# with the default executor or the Whisper transcription pool.
_b64_executor = ThreadPoolExecutor(max_workers=8, thread_name_prefix="b64enc")

# ── Pipeline stage timeouts ──────────────────────────────────────────
_METADATA_TIMEOUT = 120            # 2 min for FFprobe metadata
_EXTRACTION_TIMEOUT = 600          # 10 min for frame + audio extraction
_SUMMARY_CLIP_TIMEOUT = 900        # 15 min for summary + clip detection
_B64_ENCODE_TIMEOUT = 300          # 5 min for base64 frame encoding


@asynccontextmanager
async def _stage_timer(job_id: str, stage: str):
    """Log wall-clock time for a pipeline stage."""
    t0 = _time.monotonic()
    logger.info("[%s] Stage '%s' started", job_id, stage)
    try:
        yield
    finally:
        elapsed = _time.monotonic() - t0
        logger.info("[%s] Stage '%s' finished in %.1fs", job_id, stage, elapsed)

# Semaphore to limit concurrent analyses
_analysis_semaphore: asyncio.Semaphore | None = None

# WebSocket broadcast registry
_ws_subscribers: dict[str, list] = {}

# Cancellation events — set() means "please cancel"
_cancel_events: dict[str, asyncio.Event] = {}


class CancelledError(Exception):
    """Raised when a job is cancelled by the user."""


def request_cancel(job_id: str):
    """Signal a running job to stop at the next checkpoint."""
    ev = _cancel_events.get(job_id)
    if ev:
        ev.set()
        logger.info(f"Cancellation requested for job {job_id}")


def is_cancel_requested(job_id: str) -> bool:
    ev = _cancel_events.get(job_id)
    return ev.is_set() if ev else False


def _check_cancelled(job_id: str):
    """Raise CancelledError if the job has been cancelled."""
    if is_cancel_requested(job_id):
        raise CancelledError(f"Job {job_id} was cancelled by user")


def get_semaphore() -> asyncio.Semaphore:
    global _analysis_semaphore
    if _analysis_semaphore is None:
        _analysis_semaphore = asyncio.Semaphore(settings.CONCURRENT_ANALYSES)
    return _analysis_semaphore


def register_ws_subscriber(job_id: str, ws):
    if job_id not in _ws_subscribers:
        _ws_subscribers[job_id] = []
    _ws_subscribers[job_id].append(ws)


def unregister_ws_subscriber(job_id: str, ws):
    if job_id in _ws_subscribers:
        _ws_subscribers[job_id] = [w for w in _ws_subscribers[job_id] if w is not ws]
        if not _ws_subscribers[job_id]:
            del _ws_subscribers[job_id]


async def broadcast_ws(job_id: str, message: dict):
    """Broadcast a message to all WebSocket subscribers for a job."""
    import json
    subscribers = _ws_subscribers.get(job_id, [])
    dead = []
    for ws in subscribers:
        try:
            await ws.send_json(message)
        except Exception:
            dead.append(ws)
    for ws in dead:
        unregister_ws_subscriber(job_id, ws)


async def _update_progress(job_id: str, status: str, progress: int, message: str):
    """Update job progress in DB and broadcast via WebSocket.
    If a cancel has been requested, raises CancelledError instead of
    writing a stale progress update that would overwrite the 'cancelled' status."""
    if is_cancel_requested(job_id):
        raise CancelledError(f"Job {job_id} was cancelled by user")
    await database.update_job_status(
        job_id,
        status=status,
        progress=progress,
        progress_message=message,
    )
    await broadcast_ws(job_id, {
        "type": "status",
        "status": status,
        "progress": progress,
        "message": message,
    })


async def run_analysis(job_id: str):
    """Execute the full analysis pipeline for a video job."""
    # Set up cancellation event for this job
    _cancel_events[job_id] = asyncio.Event()
    sem = get_semaphore()

    # Broadcast immediately so the Analysis page shows status while waiting
    # for the semaphore (especially when another analysis is already running)
    await _update_progress(
        job_id, JobStatus.QUEUED, 1,
        "Preparing analysis pipeline...",
    )

    async with sem:
        try:
            await _run_analysis_inner(job_id)
        except CancelledError:
            logger.info(f"Job {job_id} cancelled by user")
            await database.update_job_status(
                job_id,
                status=JobStatus.CANCELLED,
                progress_message="Cancelled by user",
            )
            await broadcast_ws(job_id, {
                "type": "cancelled",
                "message": "Job cancelled by user",
            })
        except Exception as e:
            logger.exception(f"Analysis pipeline failed for {job_id}")
            # Preserve last known progress so the frontend can show where it
            # failed instead of the bar collapsing to 0%.
            current = await database.load_job(job_id)
            last_pct = current.progress if current and current.progress else 0
            await database.update_job_status(
                job_id,
                status=JobStatus.FAILED,
                progress=last_pct,
                progress_message=f"Failed at {last_pct}%: {str(e)[:120]}",
                error=str(e),
            )
            await broadcast_ws(job_id, {
                "type": "error",
                "message": f"Analysis failed: {str(e)}",
            })
        finally:
            _cancel_events.pop(job_id, None)


async def _run_analysis_inner(job_id: str):
    job = await database.load_job(job_id)
    if not job:
        raise RuntimeError(f"Job {job_id} not found")

    video_path = job.file_path
    job_dir = f"/data/uploads/{job_id}"
    frames_dir = os.path.join(job_dir, "frames")
    audio_path = os.path.join(job_dir, "audio.wav")

    # Record pipeline start time for ETA and total duration tracking
    _pipeline_start = _time.monotonic()
    _pipeline_start_iso = datetime.now(timezone.utc).isoformat()
    await database.update_job_status(job_id, analysis_started_at=_pipeline_start_iso)

    # Create a cancel checker bound to this job
    def cancel_check():
        _check_cancelled(job_id)

    custom_prompts = load_prompts()
    orchestrator = AIOrchestrator(
        ws_broadcast=broadcast_ws,
        custom_prompts=custom_prompts,
        cancel_check=cancel_check,
    )

    def _pipeline_elapsed():
        return _time.monotonic() - _pipeline_start

    def _pipeline_eta(current_pct):
        """Estimate remaining time based on current progress percentage."""
        if current_pct <= 2:
            return ""
        elapsed = _pipeline_elapsed()
        rate = current_pct / elapsed  # percent per second
        remaining = max(0, (100 - current_pct) / rate)
        if remaining < 60:
            return f" — ~{int(remaining)}s remaining"
        m, s = divmod(int(remaining), 60)
        return f" — ~{m}m {s}s remaining"

    # Step 1 — Video Metadata (0-5%)
    cancel_check()
    await _update_progress(job_id, JobStatus.EXTRACTING_FRAMES, 2, "Extracting video metadata...")
    logger.info("[%s] Pipeline started — video: %s", job_id, video_path)
    async with _stage_timer(job_id, "metadata"):
        try:
            metadata = await asyncio.wait_for(
                get_video_metadata(video_path), timeout=_METADATA_TIMEOUT,
            )
        except asyncio.TimeoutError:
            raise RuntimeError(
                f"Video metadata extraction timed out after {_METADATA_TIMEOUT}s. "
                "The file may be corrupt or on slow storage."
            )
    await database.update_job_status(
        job_id,
        duration=metadata["duration"],
        resolution=metadata["resolution"],
        fps=metadata["fps"],
        file_size_mb=metadata["file_size_mb"],
    )
    dur_fmt = f"{int(metadata['duration'] // 60)}:{int(metadata['duration'] % 60):02d}"
    res = metadata.get("resolution", "?")
    fps_val = metadata.get("fps", 0)
    mb = metadata.get("file_size_mb", 0)
    await _update_progress(
        job_id, JobStatus.EXTRACTING_FRAMES, 5,
        f"Metadata extracted — {res} @ {fps_val}fps, {dur_fmt} duration, {mb:.1f}MB",
    )

    # Disk space pre-check — estimate needed space from video metadata
    disk_usage = shutil.disk_usage("/data")
    # Estimate: audio WAV ~1.8MB/min + frames ~3MB + overhead
    estimated_need_mb = max(50, metadata.get("file_size_mb", 100) * 0.3)
    if disk_usage.free < estimated_need_mb * 1024 * 1024:
        raise RuntimeError(
            f"Insufficient disk space: {disk_usage.free // (1024*1024)}MB free, "
            f"estimated {int(estimated_need_mb)}MB needed. "
            f"Please free space on the /data volume."
        )

    # Broadcast GPU info early so user can see what hardware is available
    try:
        from backend.services.clip_exporter import detect_gpu_capabilities, get_encoder_label
        _gpu = detect_gpu_capabilities()
        _gpu_parts = []
        if _gpu.get("cuda_available"):
            _gpu_parts.append(f"Whisper: CUDA ({_gpu.get('gpu_name', 'GPU')})")
        else:
            # Check if GPU is detected but CUDA isn't available
            _gpu_name = _gpu.get("gpu_name", "")
            if _gpu_name and _gpu_name != "None (CPU only)":
                _gpu_parts.append(f"Whisper: CPU (GPU detected: {_gpu_name} — CUDA runtime not available)")
            else:
                _gpu_parts.append("Whisper: CPU")
        _enc_label = get_encoder_label()
        _gpu_parts.append(f"Encoding: {_enc_label}")
        # Add issues hint if GPU detected but encoder fell back to CPU
        _gpu_issues = _gpu.get("gpu_issues", [])
        if _gpu_issues:
            _gpu_parts.append("(GPU passthrough incomplete — check Settings > Advanced)")
        await broadcast_ws(job_id, {
            "type": "status",
            "status": "processing",
            "progress": 5,
            "message": f"Hardware — {' | '.join(_gpu_parts)}",
        })
    except Exception:
        pass  # Non-critical — don't break pipeline if GPU detection fails

    # Step 2 — Frame + Audio Extraction in parallel (5-15%)
    cancel_check()
    file_mb = metadata.get("file_size_mb", 0)
    duration_min = round(metadata["duration"] / 60, 1)
    size_note = f" ({file_mb:.0f}MB, {duration_min}min)" if file_mb > 50 else ""
    await _update_progress(
        job_id, JobStatus.EXTRACTING_FRAMES, 8,
        f"Extracting frames + audio{size_note}...",
    )

    async def _frame_progress(frames_so_far: int):
        pct = min(14, 8 + frames_so_far)
        await _update_progress(
            job_id, JobStatus.EXTRACTING_FRAMES, pct,
            f"Extracted {frames_so_far} frames so far{size_note}...",
        )

    # Run frame extraction and audio extraction concurrently — both are
    # independent FFmpeg reads of the source video, writing to different outputs.
    async with _stage_timer(job_id, "frame+audio extraction"):
        try:
            frames, _ = await asyncio.wait_for(
                asyncio.gather(
                    extract_frames(
                        video_path, frames_dir,
                        cancel_check=cancel_check, progress_callback=_frame_progress,
                    ),
                    extract_audio(video_path, audio_path, cancel_check=cancel_check),
                ),
                timeout=_EXTRACTION_TIMEOUT,
            )
        except asyncio.TimeoutError:
            logger.error("[%s] Frame+audio extraction timed out after %ds", job_id, _EXTRACTION_TIMEOUT)
            raise RuntimeError(
                f"Frame and audio extraction timed out after {_EXTRACTION_TIMEOUT // 60} minutes. "
                "The video file may be very large or the container is under heavy load."
            )
    total_frames = len(frames)
    logger.info("[%s] Extracted %d frames + audio track", job_id, total_frames)
    await _update_progress(
        job_id, JobStatus.EXTRACTING_FRAMES, 15,
        f"Extracted {total_frames} frames + audio track{_pipeline_eta(15)}",
    )

    # ── Steps 3+4 — Run transcription and scene analysis CONCURRENTLY ──
    # These two branches are independent: transcription needs audio,
    # scene analysis needs frames. Running them in parallel saves ~50%
    # of total processing time for long videos.

    audio_duration = metadata.get("duration", 0)

    def _fmt_time(sec):
        m, s = divmod(int(sec), 60)
        return f"{m}:{s:02d}"

    def _fmt_eta(sec):
        sec = int(sec)
        if sec < 60:
            return f"~{sec}s remaining"
        m, s = divmod(sec, 60)
        return f"~{m}m {s}s remaining"

    # Track progress from both branches; combined maps to 15-62% of pipeline
    _branch_pct = {"transcription": 0.0, "scene_analysis": 0.0}

    async def _update_branch_progress(
        branch: str, branch_pct: float, status: str, message: str,
    ):
        """Update progress from one concurrent branch, computing combined pipeline %."""
        _branch_pct[branch] = min(100.0, branch_pct)
        # Each branch contributes half the 15-62% range (23.5 points each)
        combined = (_branch_pct["transcription"] + _branch_pct["scene_analysis"]) / 200
        pipeline_pct = 15 + int(combined * 47)  # 15% to 62%
        eta = _pipeline_eta(pipeline_pct)
        await _update_progress(job_id, status, min(62, pipeline_pct), message + eta)

    # ── Branch A: Transcription (audio already extracted in Step 2) ──
    async def _branch_transcription():
        cancel_check()
        lang_label = job.language if job.language else "auto-detect"
        # Include GPU/device info in the initial transcription message
        from backend.services.transcription import whisper_device_info
        _wdev = whisper_device_info
        if _wdev["device"] == "cuda" and _wdev["gpu_name"]:
            device_label = f"GPU: {_wdev['gpu_name']} ({_wdev['compute_type']})"
        elif _wdev["device"] == "cuda":
            device_label = f"GPU: CUDA ({_wdev['compute_type']})"
        else:
            device_label = f"CPU ({_wdev['compute_type']})"
        await _update_branch_progress("transcription", 5, JobStatus.TRANSCRIBING,
            f"Transcribing audio ({lang_label}) — {device_label}")

        async def _transcribe_progress(info: dict):
            pct = info["pct"]
            lang_info = f" [{info['lang']}]" if info.get("lang") else ""
            pos = _fmt_time(info["position_sec"])
            total = _fmt_time(audio_duration) if audio_duration > 0 else "?"
            # Pipeline-wide ETA is appended by _update_branch_progress — no
            # branch-specific ETA here to avoid confusing double "remaining" messages.
            parts = [f"Transcribing{lang_info}: {pos} / {total}"]
            parts.append(f"{info['segments']} segments")
            parts.append(f"via {device_label}")
            branch_pct = 5 + pct * 0.95  # 5-100% (audio already extracted in Step 2)
            await _update_branch_progress("transcription", branch_pct,
                JobStatus.TRANSCRIBING, " \u2014 ".join(parts))

        result = await transcribe_audio(
            audio_path, language=job.language, cancel_check=cancel_check,
            progress_callback=_transcribe_progress, audio_duration=audio_duration,
        )
        await database.update_job_status(job_id, transcript=list(result))

        # AI transcript correction (optional, after initial transcription)
        if settings.AI_TRANSCRIPT_CORRECTION and result:
            from backend.services.transcript_corrector import correct_transcript, _adaptive_batch_size
            # Show which model is polishing the transcript
            _polish_info = orchestrator.get_text_model_info()
            _polish_model = _polish_info.get("model", "AI")
            _polish_label = f"Polishing transcript with {_polish_model}..."
            if _polish_info.get("is_thinking"):
                _polish_label += " (thinking model — may take 1-2 min)"
            await _update_branch_progress("transcription", 95, JobStatus.TRANSCRIBING,
                _polish_label)
            try:
                # Dynamic timeout: scale with transcript length
                # probe batch (timeout) + ceil(remaining_batches / 3) waves × timeout + buffer
                _batch_size = _adaptive_batch_size(len(result))
                _total_batches = -(-len(result) // _batch_size)
                _remaining_waves = -(- max(0, _total_batches - 1) // 3)  # concurrent waves of 3
                _per_batch = 150 if _polish_info.get("is_thinking") else 90
                # probe + waves + 30s buffer
                _correction_timeout = _per_batch + (_remaining_waves * _per_batch) + 30
                # Clamp: minimum 120s, maximum 600s (10 min)
                _correction_timeout = max(120, min(600, _correction_timeout))

                logger.info(
                    "[%s] Transcript polishing: %d segments, %d batches, timeout=%ds",
                    job_id, len(result), _total_batches, _correction_timeout,
                )
                result = await asyncio.wait_for(
                    correct_transcript(result, orchestrator, job_id=job_id),
                    timeout=_correction_timeout,
                )
                await database.update_job_status(job_id, transcript=list(result))
                logger.info("[%s] AI transcript correction applied", job_id)
            except asyncio.TimeoutError:
                logger.warning("[%s] AI transcript correction timed out after %ds (using raw)", job_id, _correction_timeout)
            except Exception as e:
                logger.warning("[%s] AI transcript correction failed (using raw): %s", job_id, e)

        speaker_count = len(set(s.speaker for s in result))
        await _update_branch_progress("transcription", 100, JobStatus.TRANSCRIBING,
            f"Transcribed {len(result)} segments \u2014 {speaker_count} speaker{'s' if speaker_count != 1 else ''} detected")
        return result

    # ── Branch B: Base64 encoding + AI scene analysis ──
    async def _branch_scene_analysis():
        cancel_check()
        # Encode frames to base64 (parallel via thread pool)
        await _update_branch_progress("scene_analysis", 0, JobStatus.ANALYZING_SCENES,
            f"Preparing {total_frames} frames for AI analysis...")

        loop = asyncio.get_running_loop()
        _completed = 0
        _batch_size = min(16, max(1, total_frames))

        for batch_start in range(0, total_frames, _batch_size):
            cancel_check()
            batch_end = min(batch_start + _batch_size, total_frames)
            batch = frames[batch_start:batch_end]

            def _encode(path):
                return frame_to_base64(path, skip_resize=True)

            try:
                results = await asyncio.wait_for(
                    asyncio.gather(*(
                        loop.run_in_executor(_b64_executor, _encode, fr.path)
                        for fr in batch
                    )),
                    timeout=_B64_ENCODE_TIMEOUT,
                )
            except asyncio.TimeoutError:
                logger.error("[%s] Base64 encoding timed out for batch %d-%d", job_id, batch_start, batch_end)
                raise RuntimeError(f"Frame encoding timed out — batch {batch_start}-{batch_end}")
            for fr, b64 in zip(batch, results):
                fr.base64 = b64

            _completed = batch_end
            pct_done = int((_completed / max(total_frames, 1)) * 100)
            branch_pct = pct_done * 0.1  # 0-10% of branch
            await _update_branch_progress("scene_analysis", branch_pct,
                JobStatus.ANALYZING_SCENES,
                f"Preparing frames: {_completed}/{total_frames} ({pct_done}%)")

        # AI scene analysis
        await _update_branch_progress("scene_analysis", 10, JobStatus.ANALYZING_SCENES,
            "Analyzing scenes with AI...")

        _scene_start = _time.monotonic()

        async def _scene_progress(frames_done, frames_total, provider_name):
            pct = int((frames_done / max(frames_total, 1)) * 100)
            branch_pct = 10 + pct * 0.9  # 10-100% of branch
            # Pipeline-wide ETA is appended by _update_branch_progress — no
            # branch-specific ETA here to avoid confusing double "remaining" messages.
            await _update_branch_progress("scene_analysis", branch_pct,
                JobStatus.ANALYZING_SCENES,
                f"Analyzing frame {frames_done}/{frames_total} via {provider_name} ({pct}%)")

        try:
            scenes_result, provider = await orchestrator.analyze_frames(
                frames, job_id, progress_callback=_scene_progress,
            )
        except CancelledError:
            raise
        except Exception as e:
            logger.exception("[%s] Scene analysis failed, continuing with empty scenes", job_id)
            scenes_result = []
            provider = "none"

        await database.update_job_status(
            job_id,
            scenes=list(scenes_result),
            provider_used={"scenes": provider},
        )
        await _update_branch_progress("scene_analysis", 100, JobStatus.ANALYZING_SCENES,
            f"Analyzed {len(scenes_result)} scenes via {provider}")

        # Log subject tracking status
        if settings.SUBJECT_TRACKING_ENABLED:
            tracked = [s for s in scenes_result if hasattr(s, 'subject_x') and s.subject_x is not None]
            sx_values = [s.subject_x for s in tracked] if tracked else []
            logger.info(
                "[SubjectTracking] ═══ SCENE ANALYSIS COMPLETE for job %s ═══",
                job_id,
            )
            logger.info(
                "[SubjectTracking] %d/%d scenes tracked, subject_x values: %s",
                len(tracked), len(scenes_result),
                sx_values if sx_values else "(none)",
            )
            if sx_values:
                logger.info(
                    "[SubjectTracking] subject_x stats: min=%d, max=%d, mean=%.1f, "
                    "unique=%d, distribution=%s",
                    min(sx_values), max(sx_values),
                    sum(sx_values) / len(sx_values),
                    len(set(sx_values)),
                    {v: sx_values.count(v) for v in sorted(set(sx_values))},
                )
            await broadcast_ws(job_id, {
                "type": "subject_tracking",
                "enabled": True,
                "tracked_scenes": len(tracked),
                "total_scenes": len(scenes_result),
                "message": f"Subject tracking: {len(tracked)}/{len(scenes_result)} scenes tracked for dynamic crop positioning",
            })
        else:
            logger.info(
                "[SubjectTracking] DISABLED for job %s — all crops will use center of frame",
                job_id,
            )
            await broadcast_ws(job_id, {
                "type": "subject_tracking",
                "enabled": False,
                "message": "Subject tracking disabled — crops will use center of frame",
            })

        return scenes_result, provider

    # Run both branches concurrently — this is the key optimization.
    # Use return_exceptions=True so one branch failing doesn't kill the other.
    logger.info("[%s] Starting concurrent transcription + scene analysis", job_id)
    _trans_scene_timeout = max(600, audio_duration * 5)
    async with _stage_timer(job_id, "transcription+scene_analysis"):
        try:
            results = await asyncio.wait_for(
                asyncio.gather(
                    _branch_transcription(),
                    _branch_scene_analysis(),
                    return_exceptions=True,
                ),
                timeout=_trans_scene_timeout,
            )
        except asyncio.TimeoutError:
            logger.error(
                "[%s] Transcription+scene analysis timed out after %.0fs",
                job_id, _trans_scene_timeout,
            )
            raise RuntimeError(
                f"Transcription and scene analysis timed out after "
                f"{int(_trans_scene_timeout // 60)} minutes."
            )

    # Unpack results, tolerating individual branch failures
    trans_result, scene_result = results

    if isinstance(trans_result, BaseException):
        if isinstance(trans_result, CancelledError):
            raise trans_result
        logger.exception("[%s] Transcription branch failed", job_id, exc_info=trans_result)
        transcript = []
    else:
        transcript = trans_result

    if isinstance(scene_result, BaseException):
        if isinstance(scene_result, CancelledError):
            raise scene_result
        logger.exception("[%s] Scene analysis branch failed", job_id, exc_info=scene_result)
        scenes, scenes_provider = [], "none"
    else:
        scenes, scenes_provider = scene_result

    speaker_count = len(set(s.speaker for s in transcript))
    logger.info(
        "[%s] Branches complete: %d transcript segments (%d speakers), %d scenes via %s",
        job_id, len(transcript), speaker_count, len(scenes), scenes_provider,
    )
    await _update_progress(
        job_id, JobStatus.ANALYZING_SCENES, 63,
        f"Transcribed {len(transcript)} segments ({speaker_count} speakers) + "
        f"{len(scenes)} scenes via {scenes_provider}",
    )

    # ── Steps 5+6 — Summary THEN clip detection (sequential) ──
    # Summary runs first so clip detection can use content context.
    # The 5-10s delay is worth the quality improvement.
    cancel_check()
    await _update_progress(
        job_id, JobStatus.GENERATING_SUMMARY, 65,
        f"Generating video summary...{_pipeline_eta(65)}",
    )

    # CRITICAL: Reset circuit breaker before critical AI operations.
    # Transcript correction (optional) may have degraded providers via
    # repeated timeouts. Summary and clip detection MUST have access to
    # all configured providers regardless of correction failures.
    orchestrator.reset_circuit_breaker()

    # Step 5: Summary first
    _summary_start = _time.monotonic()
    try:
        summary, summary_provider = await orchestrator.generate_summary(
            transcript, scenes, job_id,
        )
    except CancelledError:
        raise
    except AllProvidersFailedError:
        # All providers failed — wait briefly and retry once
        logger.warning("[%s] All providers failed for summary — retrying in 5s", job_id)
        orchestrator.reset_circuit_breaker()
        await asyncio.sleep(5)
        try:
            summary, summary_provider = await orchestrator.generate_summary(
                transcript, scenes, job_id,
            )
        except Exception:
            logger.exception("[%s] Summary generation retry also failed, building from transcript", job_id)
            fb = build_summary_from_transcript(transcript, scenes)
            summary = VideoSummary(**fb)
            summary_provider = "none"
    except Exception as e:
        logger.exception("[%s] Summary generation failed, building from transcript", job_id)
        fb = build_summary_from_transcript(transcript, scenes)
        summary = VideoSummary(**fb)
        summary_provider = "none"

    await _update_progress(
        job_id, JobStatus.GENERATING_SUMMARY, 75,
        f"Summary generated via {summary_provider} — now detecting viral clips...{_pipeline_eta(75)}",
    )

    # Build summary context string for clip detection
    summary_text = summary.overview
    if summary.key_topics:
        summary_text += f"\nKey topics: {', '.join(summary.key_topics)}"
    if summary.content_category:
        summary_text += f"\nCategory: {summary.content_category}"
    if summary.tone:
        summary_text += f"\nTone: {summary.tone}"

    # Step 5b: Audio energy analysis (runs quickly on already-extracted WAV)
    audio_energy_text = ""
    try:
        audio_moments = await analyze_audio_energy(audio_path)
        audio_energy_text = format_audio_energy_map(audio_moments)
        if audio_energy_text:
            logger.info("[%s] Audio energy analysis: %d spikes detected", job_id, len(audio_moments))
    except Exception as e:
        logger.warning("[%s] Audio energy analysis failed (non-critical): %s", job_id, e)

    # Append audio energy to summary context for clip detection
    if audio_energy_text:
        summary_text += audio_energy_text

    # Step 6: Clip detection with summary context
    cancel_check()

    # Reset again before clip detection — summary generation may have
    # had transient failures that shouldn't block clip detection.
    orchestrator.reset_circuit_breaker()

    _clips_start = _time.monotonic()

    clip_detection_task = None

    async def _clips_heartbeat():
        await asyncio.sleep(10)
        while True:
            try:
                cancel_check()
            except Exception:
                # Cancel requested — also cancel the main clip detection task
                if clip_detection_task and not clip_detection_task.done():
                    clip_detection_task.cancel()
                raise
            elapsed = int(_time.monotonic() - _clips_start)
            await _update_progress(
                job_id, JobStatus.DETECTING_CLIPS, min(93, 78 + elapsed // 10),
                f"Identifying viral moments... ({elapsed}s elapsed){_pipeline_eta(min(93, 78 + elapsed // 10))}",
            )
            await asyncio.sleep(8)

    heartbeat_task = asyncio.create_task(_clips_heartbeat())
    try:
        try:
            clip_detection_task = asyncio.ensure_future(
                orchestrator.detect_viral_clips(
                    transcript, scenes, metadata["duration"], job_id,
                    video_summary=summary_text,
                )
            )
            clips, clips_provider = await asyncio.wait_for(
                clip_detection_task,
                timeout=_SUMMARY_CLIP_TIMEOUT,
            )
        except AllProvidersFailedError:
            # All providers failed on first attempt — wait briefly for any
            # transient rate limits to clear and retry once.
            logger.warning("[%s] All providers failed for clip detection — retrying in 10s", job_id)
            orchestrator.reset_circuit_breaker()
            await asyncio.sleep(10)
            try:
                clips, clips_provider = await asyncio.wait_for(
                    orchestrator.detect_viral_clips(
                        transcript, scenes, metadata["duration"], job_id,
                        video_summary=summary_text,
                    ),
                    timeout=_SUMMARY_CLIP_TIMEOUT,
                )
            except Exception:
                logger.exception("[%s] Clip detection retry also failed", job_id)
                clips = []
                clips_provider = "none"
    except asyncio.TimeoutError:
        logger.error("[%s] Clip detection timed out", job_id)
        clips = []
        clips_provider = "none"
    except CancelledError:
        raise
    except Exception as e:
        logger.exception("[%s] Clip detection failed", job_id)
        clips = []
        clips_provider = "none"
    finally:
        heartbeat_task.cancel()
        try:
            await heartbeat_task
        except (asyncio.CancelledError, CancelledError):
            pass

    await _update_progress(
        job_id, JobStatus.DETECTING_CLIPS, 95,
        f"Summary via {summary_provider} + {len(clips)} clips via {clips_provider}",
    )

    # Snap clip boundaries to word-level timestamps for clean cuts
    if clips and transcript:
        clips = snap_all_clips(clips, transcript)

    # Save both results
    job = await database.load_job(job_id)
    provider_used = job.provider_used if job else {}
    provider_used["summary"] = summary_provider
    provider_used["clips"] = clips_provider

    # Ensure clip IDs are unique and sequential (AI may return duplicates)
    for idx, clip in enumerate(clips, start=1):
        clip.id = idx

    await database.update_job_status(
        job_id,
        summary=summary,
        clips=list(clips),
        provider_used=provider_used,
    )
    await _update_progress(
        job_id, JobStatus.DETECTING_CLIPS, 95,
        f"Summary via {summary_provider} + {len(clips)} clips via {clips_provider}",
    )

    # Step 7 — Save Results
    total_elapsed = round(_pipeline_elapsed(), 1)
    if total_elapsed < 60:
        dur_str = f"{int(total_elapsed)}s"
    else:
        m, s = divmod(int(total_elapsed), 60)
        dur_str = f"{m}m {s}s"

    await _update_progress(
        job_id, JobStatus.DETECTING_CLIPS, 98,
        f"Saving results — {len(transcript)} transcript segments, {len(scenes)} scenes, {len(clips)} clips",
    )
    # Estimate cost from AI provider token usage
    estimated_cost = orchestrator.estimate_cost()
    total_tokens = orchestrator.get_total_tokens()
    if total_tokens > 0:
        logger.info("[%s] Total AI tokens used: %d, estimated cost: $%.6f", job_id, total_tokens, estimated_cost)

    completion_msg = (
        f"Analysis complete in {dur_str} — "
        f"{len(transcript)} segments, {len(scenes)} scenes, {len(clips)} clips"
    )
    await database.update_job_status(
        job_id,
        status=JobStatus.COMPLETE,
        progress=100,
        progress_message=completion_msg,
        analysis_duration_seconds=total_elapsed,
        estimated_cost_usd=estimated_cost if estimated_cost > 0 else None,
    )
    await broadcast_ws(job_id, {
        "type": "complete",
        "progress": 100,
        "message": completion_msg,
    })
    logger.info(
        "[%s] %s (summary=%s, scenes=%s, clips=%s)",
        job_id, completion_msg,
        summary_provider, scenes_provider, clips_provider,
    )
