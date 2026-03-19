import asyncio
import base64
import json
import logging
import os
from typing import Callable, Optional

from PIL import Image

from backend.config import settings
from backend.models import FrameData

logger = logging.getLogger(__name__)

MAX_DIMENSION = 1568


async def _run_subprocess_cancellable(
    cmd: list[str],
    cancel_check: Optional[Callable] = None,
    poll_interval: float = 1.0,
) -> tuple[int, bytes]:
    """Run a subprocess with periodic cancellation checks.

    If cancel_check raises, the subprocess is terminated/killed and the
    exception propagates immediately instead of waiting for completion.
    Returns (returncode, stderr_bytes).
    """
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )

    if not cancel_check:
        _, stderr = await proc.communicate()
        return proc.returncode, stderr

    comm_task = asyncio.ensure_future(proc.communicate())
    try:
        while not comm_task.done():
            await asyncio.sleep(poll_interval)
            if not comm_task.done():
                cancel_check()  # raises CancelledError if cancelled
        _, stderr = comm_task.result()
        return proc.returncode, stderr
    except BaseException:
        # Cancel requested or other error — kill the subprocess
        proc.terminate()
        try:
            await asyncio.wait_for(proc.wait(), timeout=5.0)
        except asyncio.TimeoutError:
            proc.kill()
        comm_task.cancel()
        raise


async def get_video_metadata(video_path: str) -> dict:
    """Extract video metadata using FFprobe."""
    cmd = [
        "ffprobe", "-v", "error", "-print_format", "json",
        "-show_format", "-show_streams", video_path,
    ]
    logger.info("FFprobe command: %s", " ".join(cmd))
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=120)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        raise RuntimeError(
            "FFprobe timed out after 2 minutes — the video file may be corrupt or on slow storage."
        )
    if proc.returncode != 0:
        err_msg = stderr.decode().strip() or "(no output)"
        logger.error(f"FFprobe failed (rc={proc.returncode}) for {video_path}: {err_msg}")
        # Provide a user-friendly message for common corruption patterns
        if "Invalid data found" in err_msg or "EBML header" in err_msg:
            raise RuntimeError(
                "The video file could not be read — it may be corrupt or an incomplete download. "
                "Please check that it plays correctly on your device and try again."
            )
        raise RuntimeError(f"FFprobe failed: {err_msg}")

    data = json.loads(stdout.decode())
    fmt = data.get("format", {})
    video_stream = None
    for s in data.get("streams", []):
        if s.get("codec_type") == "video":
            video_stream = s
            break

    duration = float(fmt.get("duration", 0))
    file_size_mb = round(int(fmt.get("size", 0)) / (1024 * 1024), 2)
    resolution = ""
    fps = 0.0
    if video_stream:
        w = video_stream.get("width", 0)
        h = video_stream.get("height", 0)

        # Account for non-square pixels (SAR != 1:1).  Many cameras and
        # encoding tools produce videos where coded dimensions differ from
        # the actual display dimensions.  FFprobe reports SAR as "N:M";
        # the display width = coded_width * (SAR_num / SAR_den).
        sar_str = video_stream.get("sample_aspect_ratio", "1:1")
        try:
            sar_parts = sar_str.split(":")
            sar_num = int(sar_parts[0])
            sar_den = int(sar_parts[1]) if len(sar_parts) > 1 else 1
            if sar_num > 0 and sar_den > 0 and sar_num != sar_den:
                display_w = round(w * sar_num / sar_den)
                # Ensure even dimensions for video encoding
                display_w = display_w - (display_w % 2)
                logger.info(
                    "SAR correction: coded=%dx%d, SAR=%s, display=%dx%d",
                    w, h, sar_str, display_w, h,
                )
                w = display_w
        except (ValueError, IndexError, ZeroDivisionError):
            pass  # Malformed SAR — keep coded dimensions

        resolution = f"{w}x{h}"
        r_frame_rate = video_stream.get("r_frame_rate", "0/1")
        try:
            num, den = r_frame_rate.split("/")
            fps = round(int(num) / max(int(den), 1), 2)
        except (ValueError, ZeroDivisionError):
            fps = 0.0

    return {
        "duration": duration,
        "resolution": resolution,
        "fps": fps,
        "file_size_mb": file_size_mb,
    }


async def extract_frames(
    video_path: str,
    output_dir: str,
    sample_rate: Optional[int] = None,
    cancel_check: Optional[Callable] = None,
    progress_callback: Optional[Callable] = None,
    max_frames: Optional[int] = None,
    video_duration: Optional[float] = None,
) -> list[FrameData]:
    """Extract frames using scene detection + minimum interval fallback.

    Strategy:
    1. Scene detection (threshold 0.3) captures visual transitions
    2. Minimum interval ensures coverage during static scenes
    3. Maximum frame cap prevents API cost explosion on long videos
    4. Adaptive frame count scales with video duration
    """
    # Adaptive max_frames based on video duration
    if max_frames is None:
        if video_duration and video_duration > 0:
            target = int(video_duration / 60 * settings.FRAMES_PER_MINUTE)
            max_frames = max(settings.MIN_FRAMES, min(settings.MAX_FRAMES, target))
        else:
            max_frames = 60  # fallback

    rate = sample_rate or settings.FRAME_SAMPLE_RATE

    # Adjust sample rate to avoid over-extraction (extracting 100+ frames then
    # discarding 40% wastes I/O time). Scene detection adds ~30-40% bonus
    # frames on top of interval-based frames, so set the interval so that
    # total (interval + scene) ≈ max_frames.
    if video_duration and video_duration > 0:
        ideal_rate = int(video_duration * 1.35 / max_frames)
        if ideal_rate > rate:
            logger.info(
                "Adaptive frame rate: default=%ds, ideal=%ds (%.0fs video, %d max frames)",
                rate, ideal_rate, video_duration, max_frames,
            )
            rate = ideal_rate
    os.makedirs(output_dir, exist_ok=True)

    # Use GPU-accelerated decoding if available (speeds up long video
    # frame extraction significantly on NVIDIA/Intel hardware).
    _hw_dec: list[str] = []
    try:
        from backend.services.clip_exporter import _gpu_decode_args_for_filter
        _hw_dec = _gpu_decode_args_for_filter()
    except Exception:
        pass

    # Hybrid scene detection filter:
    # - gt(scene,0.3): capture scene changes (transitions, cuts)
    # - gte(t-prev_selected_t,{rate}): minimum interval fallback for static scenes
    # - isnan(prev_selected_t): always capture first frame
    # The OR logic ensures we get scene changes AND regular samples
    scene_filter = (
        f"select='gt(scene\\,0.3)+isnan(prev_selected_t)"
        f"+gte(t-prev_selected_t\\,{rate})',"
        f"scale='min(1024\\,iw)':'min(576\\,ih)':force_original_aspect_ratio=decrease"
    )

    cmd = [
        "ffmpeg", "-y",
        "-threads", "0",
        *_hw_dec,
        "-i", video_path,
        "-an",
        "-vf", scene_filter,
        "-vsync", "vfr",  # Variable frame rate — essential for scene detection
        "-q:v", "12",
        "-frame_pts", "1",  # Write presentation timestamps for accurate timing
        os.path.join(output_dir, "frame_%06d.jpg"),
    ]

    logger.info("FFmpeg scene-aware frame extraction: %s", " ".join(cmd))
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    comm_task = asyncio.ensure_future(proc.communicate())

    # Poll for cancellation + progress while ffmpeg runs
    poll_count = 0
    try:
        while not comm_task.done():
            await asyncio.sleep(1.0)
            poll_count += 1
            if cancel_check and not comm_task.done():
                cancel_check()
            # Report progress based on frames written so far
            if progress_callback and poll_count % 3 == 0:
                try:
                    frames_so_far = len([
                        f for f in os.listdir(output_dir)
                        if f.startswith("frame_") and f.endswith(".jpg")
                    ])
                    await progress_callback(frames_so_far)
                except Exception:
                    pass
        _, stderr = comm_task.result()
    except BaseException:
        proc.terminate()
        try:
            await asyncio.wait_for(proc.wait(), timeout=5.0)
        except asyncio.TimeoutError:
            proc.kill()
        comm_task.cancel()
        raise

    if proc.returncode != 0:
        stderr_text = stderr.decode(errors="replace")
        # Show the LAST 500 chars (the actual error), not the first (banner)
        error_tail = stderr_text[-500:] if len(stderr_text) > 500 else stderr_text

        # If GPU decode was used, retry without it — the container FFmpeg
        # may lack CUDA/cuvid support even though NVIDIA GPU is present.
        if _hw_dec:
            logger.warning(
                "FFmpeg frame extraction failed with GPU decode (%s), "
                "retrying with CPU decode: %s", _hw_dec, error_tail,
            )
            # Clean any partial frames from the failed attempt
            for f in os.listdir(output_dir):
                if f.startswith("frame_") and f.endswith(".jpg"):
                    os.remove(os.path.join(output_dir, f))

            cmd_cpu = [
                "ffmpeg", "-y",
                "-threads", "0",
                "-i", video_path,
                "-an",
                "-vf", scene_filter,
                "-vsync", "vfr",
                "-q:v", "12",
                "-frame_pts", "1",
                os.path.join(output_dir, "frame_%06d.jpg"),
            ]
            logger.info("FFmpeg CPU fallback extraction: %s", " ".join(cmd_cpu))
            proc2 = await asyncio.create_subprocess_exec(
                *cmd_cpu,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            _, stderr2 = await proc2.communicate()
            if proc2.returncode != 0:
                stderr2_text = stderr2.decode(errors="replace")
                error2_tail = stderr2_text[-500:] if len(stderr2_text) > 500 else stderr2_text
                logger.error(f"FFmpeg CPU fallback also failed: {stderr2_text}")
                raise RuntimeError(f"FFmpeg failed: {error2_tail}")
        else:
            logger.error(f"FFmpeg frame extraction failed: {stderr_text}")
            raise RuntimeError(f"FFmpeg failed: {error_tail}")

    # Collect extracted frames with actual timestamps from PTS
    frames = []
    frame_files = sorted(
        f for f in os.listdir(output_dir) if f.startswith("frame_") and f.endswith(".jpg")
    )

    if not frame_files:
        raise RuntimeError(
            "FFmpeg extracted 0 frames from the video. The file may be too short, "
            "contain only audio, or use an unsupported codec."
        )

    # If we got more frames than max, keep the most evenly spaced subset
    was_capped = False
    if len(frame_files) > max_frames:
        original_count = len(frame_files)
        step = len(frame_files) / max_frames
        indices = [int(i * step) for i in range(max_frames)]
        frame_files = [frame_files[i] for i in indices]
        was_capped = True
        logger.info("Capped frames from %d to %d", original_count, max_frames)

    for idx, fname in enumerate(frame_files):
        path = os.path.join(output_dir, fname)
        # For capped frames with known duration, estimate timestamps proportionally
        if was_capped and video_duration and video_duration > 0:
            timestamp = (idx / max(len(frame_files) - 1, 1)) * video_duration
        else:
            timestamp = idx * rate  # Fallback; will be refined below
        frames.append(FrameData(timestamp=float(timestamp), path=path))

    # Refine timestamps using ffprobe on extracted frames (concurrent)
    # Skip for large frame counts (>80) to avoid spawning too many ffprobe processes
    async def _probe_frame_pts(frame_path: str) -> float | None:
        probe_cmd = [
            "ffprobe", "-v", "error", "-select_streams", "v:0",
            "-show_entries", "frame=pts_time",
            "-of", "csv=p=0", frame_path,
        ]
        try:
            proc = await asyncio.create_subprocess_exec(
                *probe_cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            )
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=5)
            if stdout.strip():
                return float(stdout.strip())
        except (asyncio.TimeoutError, ValueError, Exception):
            pass
        return None

    if len(frames) <= 80:
        try:
            pts_results = await asyncio.gather(
                *(_probe_frame_pts(frame.path) for frame in frames),
                return_exceptions=True,
            )
            for frame, pts in zip(frames, pts_results):
                if isinstance(pts, float):
                    frame.timestamp = pts
        except Exception as e:
            logger.warning("Could not refine frame timestamps: %s", e)
    else:
        logger.info("Skipping per-frame ffprobe PTS refinement for %d frames (>80)", len(frames))

    logger.info(
        "Scene-aware extraction complete: %d frames from %s (scene detection + %ds interval)",
        len(frames), video_path, rate,
    )
    return frames


def resize_frame_if_needed(path: str) -> str:
    """Resize frame to max 1568px on longest side. Returns path (may be same)."""
    try:
        img = Image.open(path)
        w, h = img.size
        if max(w, h) > MAX_DIMENSION:
            if w > h:
                new_w = MAX_DIMENSION
                new_h = int(h * MAX_DIMENSION / w)
            else:
                new_h = MAX_DIMENSION
                new_w = int(w * MAX_DIMENSION / h)
            img = img.resize((new_w, new_h), Image.LANCZOS)
            img.save(path, "JPEG", quality=85)
    except Exception as e:
        logger.warning(f"Failed to resize frame {path}: {e}")
    return path


def frame_to_base64(path: str, skip_resize: bool = False) -> str:
    """Read frame and return base64 encoded string.

    Reads the file in a single pass and encodes to base64.
    skip_resize=True is recommended when frames were already
    downscaled during extraction (the default pipeline path).
    """
    if not skip_resize:
        resize_frame_if_needed(path)
    with open(path, "rb") as f:
        return base64.b64encode(f.read()).decode("utf-8")


async def extract_audio(
    video_path: str,
    output_path: str,
    cancel_check: Optional[Callable] = None,
) -> str:
    """Extract audio track from video as WAV for Whisper."""
    cmd = [
        "ffmpeg", "-y",
        "-i", video_path,
        "-vn", "-acodec", "pcm_s16le",
        "-ar", "16000", "-ac", "1",
        output_path,
    ]
    logger.info("FFmpeg audio extraction command: %s", " ".join(cmd))
    returncode, stderr = await _run_subprocess_cancellable(cmd, cancel_check)
    if returncode != 0:
        raise RuntimeError(f"Audio extraction failed: {stderr.decode()[:500]}")
    logger.info("Audio extraction complete: %s", output_path)
    return output_path
