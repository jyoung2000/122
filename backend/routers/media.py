"""Media upload endpoint for the multi-track video editor."""

import os
import uuid
import logging
from pathlib import Path

from fastapi import APIRouter, File, UploadFile, Query, HTTPException
from fastapi.responses import JSONResponse

logger = logging.getLogger("clipai.media")

router = APIRouter()

UPLOAD_DIR = "/data/uploads"
ALLOWED_EXTENSIONS = {
    "video": {".mp4", ".mov", ".webm", ".mkv"},
    "audio": {".mp3", ".wav", ".aac", ".ogg", ".flac"},
    "image": {".png", ".jpg", ".jpeg", ".gif", ".webp"},
}
MAX_SIZES = {
    "video": 2 * 1024 * 1024 * 1024,  # 2 GB
    "audio": 500 * 1024 * 1024,         # 500 MB
    "image": 50 * 1024 * 1024,          # 50 MB
}


def detect_media_type(filename: str) -> str | None:
    ext = Path(filename).suffix.lower()
    for media_type, extensions in ALLOWED_EXTENSIONS.items():
        if ext in extensions:
            return media_type
    return None


@router.post("/api/media/upload")
async def upload_media(
    file: UploadFile = File(...),
    job_id: str = Query(...),
):
    """Accept media upload for the multi-track editor, store to data/uploads/{job_id}/media/."""
    media_type = detect_media_type(file.filename or "")
    if not media_type:
        raise HTTPException(status_code=400, detail=f"Unsupported file type: {file.filename}")

    # Read file content
    content = await file.read()
    max_size = MAX_SIZES.get(media_type, 50 * 1024 * 1024)
    if len(content) > max_size:
        raise HTTPException(
            status_code=413,
            detail=f"File exceeds {max_size // (1024 * 1024)} MB limit for {media_type}",
        )

    # Create upload directory
    media_dir = os.path.join(UPLOAD_DIR, job_id, "media")
    os.makedirs(media_dir, exist_ok=True)

    # Generate unique filename
    media_id = str(uuid.uuid4())[:8]
    ext = Path(file.filename or "upload").suffix.lower()
    safe_filename = f"{media_id}{ext}"
    file_path = os.path.join(media_dir, safe_filename)

    # Write to disk
    with open(file_path, "wb") as f:
        f.write(content)

    logger.info("Uploaded media %s (%s, %d bytes) for job %s", safe_filename, media_type, len(content), job_id)

    # Build URL for frontend
    url = f"/api/files/{job_id}/media/{safe_filename}"

    return JSONResponse({
        "id": media_id,
        "filename": file.filename,
        "type": media_type,
        "size": len(content),
        "url": url,
    })


@router.get("/api/media/list")
async def list_media(job_id: str = Query(...)):
    """List all uploaded media files for a job."""
    media_dir = os.path.join(UPLOAD_DIR, job_id, "media")
    if not os.path.isdir(media_dir):
        return JSONResponse({"items": []})

    items = []
    for fname in sorted(os.listdir(media_dir)):
        fpath = os.path.join(media_dir, fname)
        if not os.path.isfile(fpath):
            continue
        media_type = detect_media_type(fname)
        if not media_type:
            continue
        media_id = Path(fname).stem
        items.append({
            "id": media_id,
            "filename": fname,
            "type": media_type,
            "size": os.path.getsize(fpath),
            "url": f"/api/files/{job_id}/media/{fname}",
        })
    return JSONResponse({"items": items})


@router.delete("/api/media/{media_id}")
async def delete_media(media_id: str, job_id: str = Query(...)):
    """Delete an uploaded media file."""
    media_dir = os.path.join(UPLOAD_DIR, job_id, "media")
    if not os.path.isdir(media_dir):
        raise HTTPException(status_code=404, detail="Media not found")

    for fname in os.listdir(media_dir):
        if Path(fname).stem == media_id:
            fpath = os.path.join(media_dir, fname)
            os.remove(fpath)
            logger.info("Deleted media %s for job %s", fname, job_id)
            return JSONResponse({"deleted": True, "id": media_id})

    raise HTTPException(status_code=404, detail="Media not found")
