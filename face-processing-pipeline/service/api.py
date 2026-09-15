"""Producer side: accept a job, put the photo in object storage, publish it to the queue.

    POST /v1/jobs          {"image": {"key": "..."} | {"url": "..."}, "callback_url": "...", "metadata": {}}
    POST /v1/jobs/upload   multipart: file + callback_url + metadata
    GET  /v1/jobs/{id}     where a job got to
    GET  /health

The API stores nothing itself: the photo goes to the bucket, the job goes to Redis.
"""

import json
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile

from service import queue, settings, storage
from service.schemas import JobAccepted, JobRequest


@asynccontextmanager
async def lifespan(app: FastAPI):
    storage.ensure_bucket()
    queue.ensure_group()
    yield


app = FastAPI(title="Face processing pipeline", version="1.0", lifespan=lifespan)


@app.get("/health")
def health():
    return {"ok": True, "redis": bool(queue.r().ping()), "bucket": settings.S3_BUCKET,
            "stream": settings.JOB_STREAM, "retry_schedule": settings.RETRY_SCHEDULE}


@app.post("/v1/jobs", status_code=202, response_model=JobAccepted)
def create_job(request: JobRequest):
    job_id = queue.new_job_id()
    queue.publish_job({
        "job_id": job_id,
        "image": request.image.model_dump(exclude_none=True),
        "callback_url": request.callback_url,
        "metadata": request.metadata,
    })
    return JobAccepted(job_id=job_id, status="queued")


@app.post("/v1/jobs/upload", status_code=202, response_model=JobAccepted)
def create_job_with_upload(file: UploadFile = File(...), callback_url: str = Form(...),
                           metadata: str = Form("{}")):
    """Convenience for producers that hold the bytes: upload and enqueue in one call."""
    job_id = queue.new_job_id()
    key = f"incoming/{job_id}{Path(file.filename or '').suffix.lower() or '.jpg'}"
    storage.put_bytes(key, file.file.read(), file.content_type or "application/octet-stream")
    queue.publish_job({
        "job_id": job_id,
        "image": {"key": key},
        "callback_url": callback_url,
        "metadata": json.loads(metadata),
    })
    return JobAccepted(job_id=job_id, status="queued")


@app.get("/v1/jobs/{job_id}")
def job_status(job_id: str):
    state = queue.job_state(job_id)
    if not state:
        raise HTTPException(status_code=404, detail="unknown job")
    return {
        "job_id": job_id,
        "status": state.get("status"),
        "attempts": int(state.get("attempts", 0)),
        "faces": int(state["faces"]) if state.get("faces") else None,
        "error": state.get("last_error") or None,
        "created_at": float(state["created_at"]) if state.get("created_at") else None,
        "delivered_at": float(state["delivered_at"]) if state.get("delivered_at") else None,
    }
