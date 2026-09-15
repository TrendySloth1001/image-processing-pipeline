"""Deliver a result to the caller's webhook and keep trying until they acknowledge it.

A job is only closed when the consumer answers 2xx. Until then it sits in a sorted set of
pending deliveries with the time of its next attempt, and the computed result waits in Redis
so a retry re-sends it instead of processing the photo again.
"""

import hashlib
import hmac
import json
import time

import httpx

from service import settings
from service.queue import r, set_state

PENDING = "face:deliveries"  # sorted set: job id -> when to try next
DEAD = "face:deliveries:dead"  # jobs nobody accepted within the retry schedule


def sign(body: bytes) -> str:
    """Consumers verify this to know the call really came from the pipeline."""
    return "sha256=" + hmac.new(settings.WEBHOOK_SECRET.encode(), body, hashlib.sha256).hexdigest()


def store_result(job_id: str, result: dict) -> None:
    r().set(f"result:{job_id}", json.dumps(result), ex=settings.RESULT_TTL)


def load_result(job_id: str) -> dict | None:
    raw = r().get(f"result:{job_id}")
    return json.loads(raw) if raw else None


def schedule(job_id: str, attempt: int) -> None:
    """Queue the next attempt; give up once the schedule runs out."""
    if attempt >= len(settings.RETRY_SCHEDULE):
        r().zrem(PENDING, job_id)
        r().rpush(DEAD, job_id)
        set_state(job_id, status="dead", attempts=attempt)
        return
    r().zadd(PENDING, {job_id: time.time() + settings.RETRY_SCHEDULE[attempt]})
    set_state(job_id, status="delivering", attempts=attempt)


def due(limit: int = 10) -> list[str]:
    """Jobs whose next delivery attempt is due now."""
    return r().zrangebyscore(PENDING, 0, time.time(), start=0, num=limit)


def deliver(job_id: str, log=print) -> bool:
    """One attempt. True once the consumer has acknowledged with a 2xx."""
    result = load_result(job_id)
    state = r().hgetall(f"job:{job_id}")
    if result is None or not state:  # expired or forgotten: nothing left to deliver
        r().zrem(PENDING, job_id)
        return False

    job = json.loads(state["job"])
    attempt = int(state.get("attempts", 0)) + 1
    body = json.dumps(result, separators=(",", ":")).encode()
    headers = {
        "content-type": "application/json",
        "x-face-job-id": job_id,
        "x-face-attempt": str(attempt),
        "x-face-signature": sign(body),
    }
    try:
        response = httpx.post(job["callback_url"], content=body, headers=headers,
                              timeout=settings.WEBHOOK_TIMEOUT)
        acknowledged = 200 <= response.status_code < 300
        detail = f"HTTP {response.status_code}"
    except Exception as e:
        acknowledged, detail = False, f"{type(e).__name__}: {e}"

    if acknowledged:
        r().zrem(PENDING, job_id)
        r().delete(f"result:{job_id}")
        set_state(job_id, status="delivered", attempts=attempt, delivered_at=time.time(), last_error="")
        log(f"job {job_id}: acknowledged on attempt {attempt} ({detail})")
        return True

    set_state(job_id, last_error=detail)
    schedule(job_id, attempt)
    wait = settings.RETRY_SCHEDULE[attempt] if attempt < len(settings.RETRY_SCHEDULE) else None
    log(f"job {job_id}: attempt {attempt} not acknowledged ({detail})"
        + (f", retrying in {wait}s" if wait is not None else ", giving up (dead letter)"))
    return False
