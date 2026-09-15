"""Redis Streams: one message per job, a consumer group so workers share the work.

Job bookkeeping lives in Redis, never in the worker, so any worker can pick up any job.
"""

import json
import time
import uuid

import redis

from service import settings

_redis = None


def r() -> redis.Redis:
    global _redis
    if _redis is None:
        _redis = redis.Redis.from_url(settings.REDIS_URL, decode_responses=True)
    return _redis


def new_job_id() -> str:
    return "job_" + uuid.uuid4().hex[:20]


def ensure_group() -> None:
    try:
        r().xgroup_create(settings.JOB_STREAM, settings.CONSUMER_GROUP, id="0", mkstream=True)
    except redis.ResponseError as e:
        if "BUSYGROUP" not in str(e):  # the group already exists
            raise


def publish_job(job: dict) -> str:
    """Record the job and put it on the stream. Returns the job id."""
    job_id = job["job_id"]
    r().hset(f"job:{job_id}", mapping={
        "status": "queued",
        "attempts": 0,
        "created_at": time.time(),
        "job": json.dumps(job),
    })
    r().xadd(settings.JOB_STREAM, {"job_id": job_id})
    return job_id


def job_state(job_id: str) -> dict | None:
    return r().hgetall(f"job:{job_id}") or None


def set_state(job_id: str, **fields) -> None:
    r().hset(f"job:{job_id}", mapping={k: v for k, v in fields.items() if v is not None})
