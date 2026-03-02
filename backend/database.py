import json
import logging
import os
import shutil
import asyncio
from typing import Optional

import aiofiles

from backend.models import JobResult

logger = logging.getLogger(__name__)


_file_locks: dict[str, asyncio.Lock] = {}


def _get_lock(job_id: str) -> asyncio.Lock:
    if job_id not in _file_locks:
        _file_locks[job_id] = asyncio.Lock()
    return _file_locks[job_id]


def _job_dir(job_id: str) -> str:
    return f"/data/uploads/{job_id}"


def _job_path(job_id: str) -> str:
    return os.path.join(_job_dir(job_id), "job.json")


async def save_job(job: JobResult) -> None:
    lock = _get_lock(job.job_id)
    async with lock:
        directory = _job_dir(job.job_id)
        os.makedirs(directory, exist_ok=True)
        path = _job_path(job.job_id)
        data = job.model_dump(mode="json")
        content = json.dumps(data, indent=2, default=str)
        async with aiofiles.open(path, "w") as f:
            await f.write(content)


async def load_job(job_id: str) -> Optional[JobResult]:
    path = _job_path(job_id)
    if not os.path.exists(path):
        return None
    lock = _get_lock(job_id)
    async with lock:
        async with aiofiles.open(path, "r") as f:
            content = await f.read()
        data = json.loads(content)
        return JobResult(**data)


async def list_jobs() -> list[JobResult]:
    jobs = []
    uploads_dir = "/data/uploads"
    if not os.path.exists(uploads_dir):
        return jobs
    for entry in os.listdir(uploads_dir):
        job_path = os.path.join(uploads_dir, entry, "job.json")
        if os.path.isfile(job_path):
            try:
                async with aiofiles.open(job_path, "r") as f:
                    content = await f.read()
                data = json.loads(content)
                jobs.append(JobResult(**data))
            except Exception as e:
                logger.warning("Failed to load job from %s: %s", job_path, e)
                continue
    jobs.sort(key=lambda j: j.created_at, reverse=True)
    return jobs


async def delete_job(job_id: str) -> bool:
    """Delete a job and all its associated files (uploads + outputs). Returns True if deleted."""
    directory = _job_dir(job_id)
    if not os.path.exists(directory):
        return False
    lock = _get_lock(job_id)
    async with lock:
        shutil.rmtree(directory, ignore_errors=True)
        # Also clean up exported clips / output files
        output_dir = f"/data/outputs/{job_id}"
        if os.path.exists(output_dir):
            shutil.rmtree(output_dir, ignore_errors=True)
    _file_locks.pop(job_id, None)
    return True


async def update_job_status(
    job_id: str,
    status: Optional[str] = None,
    progress: Optional[int] = None,
    progress_message: Optional[str] = None,
    **kwargs,
) -> Optional[JobResult]:
    job = await load_job(job_id)
    if job is None:
        return None
    if status is not None:
        job.status = status
    if progress is not None:
        job.progress = progress
    if progress_message is not None:
        job.progress_message = progress_message
    from datetime import datetime, timezone
    job.updated_at = datetime.now(timezone.utc).isoformat()
    for key, value in kwargs.items():
        if hasattr(job, key):
            setattr(job, key, value)
    await save_job(job)
    return job
