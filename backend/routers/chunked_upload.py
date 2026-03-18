"""Chunked upload endpoints for reliable large-file uploads.

Flow:
  1.  POST /api/upload/init          → { upload_id, chunk_size }
  2.  POST /api/upload/chunk         → { received, hash_ok, ... }   (repeat)
  3.  POST /api/upload/complete      → { job_id, status, qa }
  4.  GET  /api/upload/status/{id}   → live QA / progress

Designed to work regardless of GPU state — chunks are small enough that
memory pressure from CUDA contexts cannot stall the transfer.
"""

import asyncio
import errno
import hashlib
import logging
import os
import time
import uuid
from datetime import datetime, timezone
from typing import Optional

import aiofiles
from fastapi import APIRouter, BackgroundTasks, HTTPException, Request, UploadFile, File, Form
from pydantic import BaseModel

from backend.config import settings
from backend.models import JobResult, JobStatus
from backend import database
from backend.services.pipeline import run_analysis

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/upload", tags=["chunked-upload"])

ALLOWED_EXTENSIONS = {"mp4", "mov", "avi", "mkv", "webm"}
CHUNK_SIZE = 5 * 1024 * 1024  # 5 MB default
UPLOAD_DIR = "/data/uploads"
# Auto-expire stale uploads after 2 hours
UPLOAD_EXPIRE_SECONDS = 2 * 60 * 60

# In-memory registry of active uploads
_active_uploads: dict[str, dict] = {}


# ── Pydantic models ──────────────────────────────────────────────────────────

class InitRequest(BaseModel):
    filename: str
    file_size: int
    language: str = ""
    chunk_size: Optional[int] = None


class InitResponse(BaseModel):
    upload_id: str
    chunk_size: int
    total_chunks: int


class ChunkResponse(BaseModel):
    upload_id: str
    chunk_index: int
    received_bytes: int
    hash_ok: bool
    chunks_done: int
    total_chunks: int
    percent: float


class CompleteResponse(BaseModel):
    job_id: str
    status: str
    filename: str
    file_size_mb: float
    qa: dict


class StatusResponse(BaseModel):
    upload_id: str
    filename: str
    file_size: int
    chunks_done: int
    total_chunks: int
    bytes_received: int
    percent: float
    state: str  # "uploading", "assembling", "validating", "complete", "error"
    qa: dict
    error: Optional[str] = None


# ── Magic-byte validation (reused from upload.py) ────────────────────────────

_MAGIC = {
    "mkv": (0, b"\x1a\x45\xdf\xa3"),
    "webm": (0, b"\x1a\x45\xdf\xa3"),
    "avi": (0, b"RIFF"),
}
_FTYP_MAGIC = b"ftyp"


def _validate_video_header(path: str, ext: str) -> str | None:
    with open(path, "rb") as f:
        header = f.read(12)
    if len(header) < 8:
        return "File is too small to be a valid video"
    if header[:8] == b"\x00" * 8:
        return "File appears corrupt — header is all zeros"
    if ext in _MAGIC:
        offset, magic = _MAGIC[ext]
        if header[offset:offset + len(magic)] != magic:
            return f"File header does not match expected {ext.upper()} format"
    elif ext in ("mp4", "mov"):
        if header[4:8] != _FTYP_MAGIC:
            return f"File header does not match expected {ext.upper()} format"
    return None


def _validate_file_integrity(path: str, expected_size: int) -> dict:
    """Run QA checks on the assembled file. Returns a dict of check results."""
    checks = {}
    try:
        actual_size = os.path.getsize(path)
        checks["size_match"] = {
            "pass": actual_size == expected_size,
            "expected": expected_size,
            "actual": actual_size,
        }
    except OSError:
        checks["size_match"] = {"pass": False, "error": "File not found"}

    # Check file is readable
    try:
        with open(path, "rb") as f:
            head = f.read(4096)
            f.seek(0, 2)
            tail_start = max(0, f.tell() - 4096)
            f.seek(tail_start)
            tail = f.read(4096)
        checks["readable"] = {"pass": True}
        checks["non_empty"] = {"pass": len(head) > 0}
        # Check tail isn't all zeros (truncated download)
        checks["tail_valid"] = {
            "pass": not all(b == 0 for b in tail[-512:]) if len(tail) >= 512 else True
        }
    except OSError as e:
        checks["readable"] = {"pass": False, "error": str(e)}

    return checks


def _cleanup_upload(upload_id: str):
    """Remove temp chunks and upload entry."""
    info = _active_uploads.pop(upload_id, None)
    if not info:
        return
    chunk_dir = info.get("chunk_dir", "")
    if chunk_dir and os.path.isdir(chunk_dir):
        try:
            for f in os.listdir(chunk_dir):
                os.remove(os.path.join(chunk_dir, f))
            os.rmdir(chunk_dir)
        except OSError:
            pass


def _expire_stale_uploads():
    """Remove uploads older than UPLOAD_EXPIRE_SECONDS."""
    now = time.time()
    stale = [uid for uid, info in _active_uploads.items()
             if now - info.get("created", now) > UPLOAD_EXPIRE_SECONDS]
    for uid in stale:
        logger.info("Expiring stale upload %s", uid)
        _cleanup_upload(uid)


# ── Endpoints ────────────────────────────────────────────────────────────────

@router.post("/init", response_model=InitResponse)
async def init_upload(req: InitRequest):
    """Initialize a chunked upload session."""
    _expire_stale_uploads()

    ext = req.filename.rsplit(".", 1)[-1].lower() if "." in req.filename else ""
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(400, f"Unsupported format .{ext}. Allowed: {', '.join(ALLOWED_EXTENSIONS)}")

    if req.file_size <= 0:
        raise HTTPException(400, "Invalid file size")

    chunk_size = req.chunk_size or CHUNK_SIZE
    # Clamp chunk size to reasonable range
    chunk_size = max(1 * 1024 * 1024, min(chunk_size, 20 * 1024 * 1024))
    total_chunks = -(-req.file_size // chunk_size)  # ceiling division

    upload_id = str(uuid.uuid4())
    chunk_dir = os.path.join(UPLOAD_DIR, f".chunked_{upload_id}")
    os.makedirs(chunk_dir, exist_ok=True)

    _active_uploads[upload_id] = {
        "filename": req.filename,
        "file_size": req.file_size,
        "language": req.language,
        "ext": ext,
        "chunk_size": chunk_size,
        "total_chunks": total_chunks,
        "chunks_received": {},
        "bytes_received": 0,
        "chunk_dir": chunk_dir,
        "state": "uploading",
        "qa": {},
        "error": None,
        "created": time.time(),
    }

    logger.info("Chunked upload init: %s (%s, %d bytes, %d chunks of %d)",
                upload_id, req.filename, req.file_size, total_chunks, chunk_size)

    return InitResponse(upload_id=upload_id, chunk_size=chunk_size, total_chunks=total_chunks)


@router.post("/chunk", response_model=ChunkResponse)
async def upload_chunk(
    upload_id: str = Form(...),
    chunk_index: int = Form(...),
    chunk_hash: str = Form(""),
    file: UploadFile = File(...),
):
    """Upload a single chunk. Validates hash if provided."""
    info = _active_uploads.get(upload_id)
    if not info:
        raise HTTPException(404, "Upload session not found or expired")
    if info["state"] != "uploading":
        raise HTTPException(409, f"Upload is in state '{info['state']}', cannot accept chunks")
    if chunk_index < 0 or chunk_index >= info["total_chunks"]:
        raise HTTPException(400, f"Invalid chunk index {chunk_index} (total: {info['total_chunks']})")

    data = await file.read()
    received = len(data)

    # Validate hash if provided (MD5 hex)
    hash_ok = True
    if chunk_hash:
        actual_hash = hashlib.md5(data).hexdigest()
        hash_ok = actual_hash == chunk_hash
        if not hash_ok:
            logger.warning("Chunk %d hash mismatch for upload %s: expected %s got %s",
                           chunk_index, upload_id, chunk_hash, actual_hash)
            raise HTTPException(422, f"Chunk {chunk_index} hash mismatch. Expected {chunk_hash}, got {actual_hash}")

    # Write chunk to disk
    chunk_path = os.path.join(info["chunk_dir"], f"chunk_{chunk_index:06d}")
    try:
        async with aiofiles.open(chunk_path, "wb") as f:
            await f.write(data)
    except OSError as exc:
        if exc.errno == errno.ENOSPC:
            raise HTTPException(507, "Server storage is full")
        raise

    # Track progress
    if chunk_index not in info["chunks_received"]:
        info["bytes_received"] += received
    info["chunks_received"][chunk_index] = received
    chunks_done = len(info["chunks_received"])
    percent = round(chunks_done / info["total_chunks"] * 100, 1)

    return ChunkResponse(
        upload_id=upload_id,
        chunk_index=chunk_index,
        received_bytes=received,
        hash_ok=hash_ok,
        chunks_done=chunks_done,
        total_chunks=info["total_chunks"],
        percent=percent,
    )


def _assemble_chunks(chunk_dir: str, tmp_path: str, total_chunks: int) -> tuple[int, str]:
    """Assemble chunk files into a single video file (runs in thread).

    Returns (total_bytes_written, md5_hex_digest).
    This runs synchronously in a thread to avoid the overhead of 100+
    async file open/read/close cycles through the aiofiles thread pool.
    """
    total_written = 0
    file_md5 = hashlib.md5()
    t0 = time.monotonic()
    logger.info("Assembly starting: %d chunks → %s", total_chunks, tmp_path)
    with open(tmp_path, "wb") as out:
        for i in range(total_chunks):
            chunk_path = os.path.join(chunk_dir, f"chunk_{i:06d}")
            if not os.path.exists(chunk_path):
                raise FileNotFoundError(f"Missing chunk file: {chunk_path}")
            with open(chunk_path, "rb") as cf:
                while True:
                    block = cf.read(1024 * 1024)  # 1MB blocks for memory efficiency
                    if not block:
                        break
                    out.write(block)
                    file_md5.update(block)
                    total_written += len(block)
            # Log progress every 25 chunks
            if (i + 1) % 25 == 0 or i == total_chunks - 1:
                elapsed = time.monotonic() - t0
                mb_written = total_written / (1024 * 1024)
                logger.info("Assembly progress: %d/%d chunks (%.1f MB, %.1fs)",
                            i + 1, total_chunks, mb_written, elapsed)
    elapsed = time.monotonic() - t0
    logger.info("Assembly complete: %.1f MB in %.1fs (%.1f MB/s)",
                total_written / (1024 * 1024), elapsed,
                (total_written / (1024 * 1024)) / max(elapsed, 0.001))
    return total_written, file_md5.hexdigest()


@router.post("/complete", response_model=CompleteResponse)
async def complete_upload(
    upload_id: str = Form(...),
    file_hash: str = Form(""),
    background_tasks: BackgroundTasks = None,
):
    """Assemble chunks, validate, and start analysis pipeline."""
    info = _active_uploads.get(upload_id)
    if not info:
        raise HTTPException(404, "Upload session not found or expired")

    chunks_done = len(info["chunks_received"])
    if chunks_done < info["total_chunks"]:
        missing = info["total_chunks"] - chunks_done
        raise HTTPException(
            400,
            f"Upload incomplete: {missing} of {info['total_chunks']} chunks missing"
        )

    info["state"] = "assembling"
    job_id = str(uuid.uuid4())
    job_dir = os.path.join(UPLOAD_DIR, job_id)
    qa = {}
    logger.info("Starting complete_upload for %s (%d chunks, %.1f MB)",
                upload_id, info["total_chunks"], info["file_size"] / (1024 * 1024))

    try:
        await asyncio.to_thread(os.makedirs, job_dir, exist_ok=True)
    except OSError as exc:
        if exc.errno == errno.ENOSPC:
            info["state"] = "error"
            info["error"] = "Disk full"
            raise HTTPException(507, "Server storage is full")
        raise

    tmp_path = os.path.join(job_dir, "video.tmp")

    # Assemble chunks in a single thread (much faster than per-chunk async I/O)
    try:
        total_written, assembled_hash = await asyncio.wait_for(
            asyncio.to_thread(
                _assemble_chunks, info["chunk_dir"], tmp_path, info["total_chunks"]
            ),
            timeout=600,  # 10 minute timeout for very large files
        )
    except asyncio.TimeoutError:
        info["state"] = "error"
        info["error"] = "Assembly timed out after 10 minutes"
        logger.error("Chunked upload %s assembly timed out", upload_id)
        # Clean up partial file
        try:
            os.remove(tmp_path)
            if not os.listdir(job_dir):
                os.rmdir(job_dir)
        except OSError:
            pass
        raise HTTPException(504, "File assembly timed out — the file may be too large")
    except OSError as exc:
        info["state"] = "error"
        info["error"] = str(exc)
        if exc.errno == errno.ENOSPC:
            raise HTTPException(507, "Server storage is full during assembly")
        logger.error("Chunked upload %s assembly OS error: %s", upload_id, exc)
        raise HTTPException(500, detail={"message": f"Assembly failed: {exc}", "qa": {}})
    except Exception as exc:
        info["state"] = "error"
        info["error"] = str(exc)
        logger.exception("Chunked upload %s assembly unexpected error", upload_id)
        raise HTTPException(500, detail={"message": f"Assembly failed: {exc}", "qa": {}})

    # QA: check assembled file hash
    if file_hash:
        qa["file_hash"] = {
            "pass": assembled_hash == file_hash,
            "expected": file_hash,
            "actual": assembled_hash,
        }
    else:
        qa["file_hash"] = {"pass": True, "note": "No client hash provided, skipped"}

    # QA: size match
    qa["size_match"] = {
        "pass": total_written == info["file_size"],
        "expected": info["file_size"],
        "actual": total_written,
    }

    info["state"] = "validating"
    logger.info("Assembly done for %s, starting validation", upload_id)

    # Rename to final path
    ext = info["ext"]
    video_path = os.path.join(job_dir, f"video.{ext}")
    await asyncio.to_thread(os.rename, tmp_path, video_path)

    # QA: file integrity checks
    integrity = await asyncio.to_thread(_validate_file_integrity, video_path, info["file_size"])
    qa["integrity"] = integrity

    # QA: video header
    header_err = await asyncio.to_thread(_validate_video_header, video_path, ext)
    qa["header_valid"] = {"pass": header_err is None, "error": header_err}
    logger.info("Validation done for %s: header=%s", upload_id, "OK" if not header_err else header_err)

    if header_err:
        info["state"] = "error"
        info["error"] = header_err
        info["qa"] = qa
        # Clean up bad file
        try:
            os.remove(video_path)
            if not os.listdir(job_dir):
                os.rmdir(job_dir)
        except OSError:
            pass
        raise HTTPException(422, detail={"message": header_err, "qa": qa})

    # Check all QA passed
    all_passed = all(
        check.get("pass", True)
        for check in qa.values()
        if isinstance(check, dict)
    )
    # Sub-checks in integrity
    if isinstance(qa.get("integrity"), dict):
        for sub in qa["integrity"].values():
            if isinstance(sub, dict) and not sub.get("pass", True):
                all_passed = False

    qa["overall"] = {"pass": all_passed}
    info["state"] = "complete"
    info["qa"] = qa

    # Clean up chunks in background thread (avoid blocking event loop)
    def _cleanup_chunk_dir(cdir: str):
        try:
            for f in os.listdir(cdir):
                os.remove(os.path.join(cdir, f))
            os.rmdir(cdir)
        except OSError:
            pass

    asyncio.get_event_loop().run_in_executor(None, _cleanup_chunk_dir, info["chunk_dir"])

    file_size_mb = round(total_written / (1024 * 1024), 2)
    filename = info["filename"]
    lang = info["language"].strip().lower()

    logger.info("Chunked upload complete: %s → %s (%d bytes, QA: %s)",
                upload_id, video_path, total_written, "PASS" if all_passed else "FAIL")

    # Create job
    now = datetime.now(timezone.utc).isoformat()
    job = JobResult(
        job_id=job_id,
        filename=filename,
        file_path=video_path,
        file_size_mb=file_size_mb,
        language=lang,
        status=JobStatus.QUEUED,
        progress=0,
        progress_message="Uploaded, waiting for analysis",
        created_at=now,
        updated_at=now,
    )
    await database.save_job(job)

    if settings.AUTO_ANALYZE and background_tasks:
        background_tasks.add_task(run_analysis, job_id)
        job.progress_message = "Analysis starting..."
        await database.save_job(job)

    # Remove from active uploads (keep qa accessible via status for a bit)
    info["job_id"] = job_id

    return CompleteResponse(
        job_id=job_id,
        status=str(job.status),
        filename=filename,
        file_size_mb=file_size_mb,
        qa=qa,
    )


@router.get("/status/{upload_id}", response_model=StatusResponse)
async def upload_status(upload_id: str):
    """Get live status and QA info for an in-progress upload."""
    info = _active_uploads.get(upload_id)
    if not info:
        raise HTTPException(404, "Upload session not found or expired")

    chunks_done = len(info["chunks_received"])
    percent = round(chunks_done / info["total_chunks"] * 100, 1) if info["total_chunks"] > 0 else 0

    return StatusResponse(
        upload_id=upload_id,
        filename=info["filename"],
        file_size=info["file_size"],
        chunks_done=chunks_done,
        total_chunks=info["total_chunks"],
        bytes_received=info["bytes_received"],
        percent=percent,
        state=info["state"],
        qa=info.get("qa", {}),
        error=info.get("error"),
    )
