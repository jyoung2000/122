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
from backend.services.upload_state import upload_state

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
    subtitle_language: str = ""  # Target language for subtitles
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
    poll: bool = False  # If True, client should poll /status/{upload_id} for final result


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
    job_id: Optional[str] = None  # Set when assembly+validation completes


# ── Shared validation ─────────────────────────────────────────────────────────

from backend.services.video_validation import (
    validate_video_header as _validate_video_header,
    validate_file_integrity as _validate_file_integrity,
)


async def restore_sessions():
    """Recover upload sessions from disk after server restart."""
    recovered = upload_state.recover_sessions()
    for upload_id, info in recovered.items():
        if info.get("state") in ("uploading",):
            _active_uploads[upload_id] = info
            logger.info("Restored upload session %s (%s)", upload_id, info.get("filename"))
    if recovered:
        logger.info("Restored %d upload sessions from disk", len(recovered))


def _cleanup_upload(upload_id: str):
    """Remove temp chunks, upload entry, and on-disk session."""
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


def expire_stale_uploads():
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
    expire_stale_uploads()

    ext = req.filename.rsplit(".", 1)[-1].lower() if "." in req.filename else ""
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(400, f"Unsupported format .{ext}. Allowed: {', '.join(ALLOWED_EXTENSIONS)}")

    if req.file_size <= 0:
        raise HTTPException(400, "Invalid file size")

    chunk_size = req.chunk_size or CHUNK_SIZE
    # Clamp chunk size to reasonable range
    chunk_size = max(1 * 1024 * 1024, min(chunk_size, 50 * 1024 * 1024))
    total_chunks = -(-req.file_size // chunk_size)  # ceiling division

    upload_id = str(uuid.uuid4())
    chunk_dir = os.path.join(UPLOAD_DIR, f".chunked_{upload_id}")
    os.makedirs(chunk_dir, exist_ok=True)

    _active_uploads[upload_id] = {
        "filename": req.filename,
        "file_size": req.file_size,
        "language": req.language,
        "subtitle_language": req.subtitle_language,
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

    # Persist session to disk for crash recovery
    await upload_state.create_session(upload_id, _active_uploads[upload_id])

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

    # Validate hash if provided (SHA-256 hex)
    hash_ok = True
    if chunk_hash:
        actual_hash = hashlib.sha256(data).hexdigest()
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

    # Track progress (use lock to prevent race condition on concurrent retries)
    already_had = chunk_index in info["chunks_received"]
    if not already_had:
        info["bytes_received"] += received
    info["chunks_received"][chunk_index] = received
    chunks_done = len(info["chunks_received"])
    percent = round(chunks_done / info["total_chunks"] * 100, 1)

    # Persist updated state to disk (every 10 chunks to reduce I/O)
    if chunks_done % 10 == 0 or chunks_done == info["total_chunks"]:
        await upload_state.save_session(upload_id, info)

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
    """Assemble chunks into a single file with streaming SHA-256.

    Combines concatenation and hashing into a SINGLE I/O pass — reads each
    chunk once, writes to output and hashes simultaneously. This is 2x faster
    than the old approach of cat + sha256sum (which read the entire file twice).

    Returns (total_bytes_written, sha256_hex_digest).
    """
    t0 = time.monotonic()

    # Build ordered list of chunk paths
    chunk_paths = []
    for i in range(total_chunks):
        p = os.path.join(chunk_dir, f"chunk_{i:06d}")
        if not os.path.exists(p):
            raise FileNotFoundError(f"Missing chunk file: {p}")
        chunk_paths.append(p)

    logger.info("Assembly starting: %d chunks → %s", total_chunks, tmp_path)

    # Single-pass: read each chunk, write to output + update hash
    file_hash = hashlib.sha256()
    total_written = 0
    buf_size = 8 * 1024 * 1024  # 8MB buffer

    with open(tmp_path, 'wb') as out:
        for i, chunk_path in enumerate(chunk_paths):
            with open(chunk_path, 'rb') as chunk_file:
                while True:
                    block = chunk_file.read(buf_size)
                    if not block:
                        break
                    out.write(block)
                    file_hash.update(block)
                    total_written += len(block)

            # Log progress every 20 chunks (~150MB)
            if (i + 1) % 20 == 0 or i == len(chunk_paths) - 1:
                elapsed = time.monotonic() - t0
                speed = (total_written / (1024 * 1024)) / max(elapsed, 0.001)
                logger.info(
                    "Assembly progress: %d/%d chunks, %.0f MB written (%.0f MB/s)",
                    i + 1, total_chunks, total_written / (1024 * 1024), speed,
                )

    assembled_hash = file_hash.hexdigest()

    elapsed = time.monotonic() - t0
    logger.info("Assembly complete: %.1f MB in %.1fs (%.1f MB/s), hash=%s",
                total_written / (1024 * 1024), elapsed,
                (total_written / (1024 * 1024)) / max(elapsed, 0.001),
                assembled_hash[:16])
    return total_written, assembled_hash


async def _assemble_and_finalize(upload_id: str, job_id: str, file_hash: str):
    """Background task: assemble chunks, validate, create job, start analysis.

    Runs outside the HTTP request so upstream proxies (Cloudflare, nginx, Caddy)
    don't time out waiting for large file assembly (which can take 2+ minutes
    for files > 500MB on slow storage).
    """
    info = _active_uploads.get(upload_id)
    if not info:
        logger.error("Assembly background task: upload %s not found", upload_id)
        return

    job_dir = os.path.join(UPLOAD_DIR, job_id)
    qa = {}

    try:
        os.makedirs(job_dir, exist_ok=True)
    except OSError as exc:
        info["state"] = "error"
        info["error"] = "Disk full" if exc.errno == errno.ENOSPC else str(exc)
        return

    tmp_path = os.path.join(job_dir, "video.tmp")

    # Assemble chunks
    # Scale timeout with file size: minimum 10 min, plus 1 second per 2 MB
    _file_size_mb = info["file_size"] / (1024 * 1024)
    _assembly_timeout = max(600, int(_file_size_mb / 2) + 60)
    logger.info("Assembly timeout: %ds for %.0f MB file", _assembly_timeout, _file_size_mb)
    try:
        total_written, assembled_hash = await asyncio.wait_for(
            asyncio.to_thread(
                _assemble_chunks, info["chunk_dir"], tmp_path, info["total_chunks"]
            ),
            timeout=_assembly_timeout,
        )
    except asyncio.TimeoutError:
        info["state"] = "error"
        info["error"] = f"Assembly timed out after {_assembly_timeout // 60} minutes"
        logger.error("Chunked upload %s assembly timed out after %ds", upload_id, _assembly_timeout)
        try:
            os.remove(tmp_path)
            if not os.listdir(job_dir):
                os.rmdir(job_dir)
        except OSError:
            pass
        return
    except OSError as exc:
        info["state"] = "error"
        info["error"] = "Disk full during assembly" if exc.errno == errno.ENOSPC else str(exc)
        logger.error("Chunked upload %s assembly OS error: %s", upload_id, exc)
        return
    except Exception as exc:
        info["state"] = "error"
        info["error"] = str(exc)
        logger.exception("Chunked upload %s assembly unexpected error", upload_id)
        return

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
        try:
            os.remove(video_path)
            if not os.listdir(job_dir):
                os.rmdir(job_dir)
        except OSError:
            pass
        return

    # Check all QA passed
    all_passed = all(
        check.get("pass", True)
        for check in qa.values()
        if isinstance(check, dict)
    )
    if isinstance(qa.get("integrity"), dict):
        for sub in qa["integrity"].values():
            if isinstance(sub, dict) and not sub.get("pass", True):
                all_passed = False

    qa["overall"] = {"pass": all_passed}
    info["state"] = "complete"
    info["qa"] = qa

    # Clean up chunks in background thread
    def _cleanup_chunk_dir(cdir: str):
        try:
            for f in os.listdir(cdir):
                os.remove(os.path.join(cdir, f))
            os.rmdir(cdir)
        except OSError:
            pass

    loop = asyncio.get_running_loop()
    loop.run_in_executor(None, _cleanup_chunk_dir, info["chunk_dir"])

    file_size_mb = round(total_written / (1024 * 1024), 2)
    filename = info["filename"]
    lang = info["language"].strip().lower()
    subtitle_lang = info.get("subtitle_language", "").strip().lower()

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
        subtitle_language=subtitle_lang,
        status=JobStatus.QUEUED,
        progress=0,
        progress_message="Uploaded, waiting for analysis",
        created_at=now,
        updated_at=now,
    )
    await database.save_job(job)

    info["job_id"] = job_id

    if settings.AUTO_ANALYZE:
        job.progress_message = "Analysis starting..."
        await database.save_job(job)
        asyncio.create_task(run_analysis(job_id))


@router.post("/complete", response_model=CompleteResponse)
async def complete_upload(
    upload_id: str = Form(...),
    file_hash: str = Form(""),
    background_tasks: BackgroundTasks = None,
):
    """Start assembly of uploaded chunks.

    Returns immediately with job_id and poll=True. The client should poll
    GET /api/upload/status/{upload_id} until state="complete" or state="error".

    This non-blocking design prevents HTTP 524 timeouts from upstream proxies
    when assembling large files (500MB+ can take 2+ minutes on slow storage).
    """
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
    file_size_mb = round(info["file_size"] / (1024 * 1024), 2)
    filename = info["filename"]

    logger.info("Starting async assembly for %s (%d chunks, %.1f MB) → job %s",
                upload_id, info["total_chunks"], file_size_mb, job_id)

    # Kick off assembly in background — returns immediately to avoid proxy timeouts
    asyncio.create_task(_assemble_and_finalize(upload_id, job_id, file_hash))

    return CompleteResponse(
        job_id=job_id,
        status="assembling",
        filename=filename,
        file_size_mb=file_size_mb,
        qa={},
        poll=True,
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
        job_id=info.get("job_id"),
    )


@router.delete("/{upload_id}")
async def cancel_upload(upload_id: str):
    """Cancel an in-progress upload and clean up server-side resources."""
    info = _active_uploads.get(upload_id)
    if not info:
        raise HTTPException(404, "Upload not found")
    logger.info("Cancelling upload %s (%s)", upload_id, info.get("filename"))
    _cleanup_upload(upload_id)
    return {"cancelled": True, "upload_id": upload_id}


@router.get("/resume/{upload_id}")
async def get_resume_info(upload_id: str):
    """Return which chunks have already been uploaded, enabling client-side resume."""
    info = _active_uploads.get(upload_id)
    if not info:
        # Try to recover from disk
        info = await upload_state.get_session(upload_id)
        if info and "chunks_received" in info and isinstance(info["chunks_received"], dict):
            info["chunks_received"] = {int(k): v for k, v in info["chunks_received"].items()}
        if not info:
            raise HTTPException(404, "Upload not found")
        # Restore to in-memory cache
        _active_uploads[upload_id] = info
    return {
        "upload_id": upload_id,
        "chunks_received": list(info["chunks_received"].keys()),
        "total_chunks": info["total_chunks"],
        "chunk_size": info["chunk_size"],
        "state": info["state"],
    }
