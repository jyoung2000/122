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
) -> list[FrameData]:
    """Extract frames from video at given sample rate using FFmpeg."""
    rate = sample_rate or settings.FRAME_SAMPLE_RATE
    os.makedirs(output_dir, exist_ok=True)

    cmd = [
        "ffmpeg", "-y",
        "-threads", "0",
        "-i", video_path,
        "-an",  # skip audio decoding — only extracting video frames
        "-vf", f"fps=1/{rate},scale='min(1024,iw)':'min(576,ih)':force_original_aspect_ratio=decrease",
        "-q:v", "12",
        os.path.join(output_dir, "frame_%06d.jpg"),
    ]

    logger.info("FFmpeg frame extraction command: %s", " ".join(cmd))
    # Use a custom runner that also monitors output frame count for progress
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
        logger.error(f"FFmpeg frame extraction failed: {stderr.decode()}")
        raise RuntimeError(f"FFmpeg failed: {stderr.decode()[:500]}")

    # Collect extracted frames
    frames = []
    frame_files = sorted(
        f for f in os.listdir(output_dir) if f.startswith("frame_") and f.endswith(".jpg")
    )
    for idx, fname in enumerate(frame_files):
        path = os.path.join(output_dir, fname)
        timestamp = idx * rate
        frames.append(FrameData(timestamp=float(timestamp), path=path))

    logger.info("Frame extraction complete: %d frames from %s", len(frames), video_path)
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
