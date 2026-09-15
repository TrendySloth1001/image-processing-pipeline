"""Consumer side: take a job off the stream, find the faces, deliver the result.

Run several of these: `docker compose up -d --scale worker=3`. They share one consumer group,
so each job goes to exactly one worker, and a job left unacked by a crashed worker is claimed
by another after CLAIM_IDLE_MS.
"""

import json
import os
import time

import httpx

from service import delivery, queue, settings, storage
from service.processor import models, process


def fetch(image: dict) -> bytes:
    if image.get("key"):
        return storage.get_bytes(image["key"])
    response = httpx.get(image["url"], timeout=30, follow_redirects=True)
    response.raise_for_status()
    return response.content


def handle(job_id: str, log=print) -> None:
    """Process one job, then hand it to the delivery loop. Safe to call twice for one job."""
    state = queue.job_state(job_id)
    if not state:
        log(f"job {job_id}: no longer known, skipping")
        return
    if delivery.load_result(job_id) is not None:  # already processed, still waiting for an ack
        log(f"job {job_id}: result already computed, delivery still pending")
        return

    job = json.loads(state["job"])
    queue.set_state(job_id, status="processing")
    started = time.time()
    try:
        result = {"status": "succeeded", **process(fetch(job["image"]))}
        log(f"job {job_id}: {len(result['faces'])} face(s) of {result['detected']} detected "
            f"in {result['took_ms']}ms")
    except Exception as e:
        result = {"status": "failed", "error": f"{type(e).__name__}: {e}"}
        log(f"job {job_id}: failed after {int((time.time() - started) * 1000)}ms ({result['error']})")

    result = {"job_id": job_id, "metadata": job.get("metadata", {}), **result}
    delivery.store_result(job_id, result)
    queue.set_state(job_id, faces=len(result.get("faces", [])))
    delivery.schedule(job_id, attempt=0)  # first attempt is immediate


def main() -> None:
    storage.ensure_bucket()
    queue.ensure_group()
    consumer = f"worker-{os.getpid()}"
    print("loading SCRFD and ArcFace…", flush=True)
    models()
    print(f"{consumer} ready: stream {settings.JOB_STREAM}, group {settings.CONSUMER_GROUP}", flush=True)

    while True:
        # 1. deliveries that are due (first attempts and retries)
        for job_id in delivery.due():
            delivery.deliver(job_id)

        # 2. jobs a crashed worker never finished
        claimed = queue.r().xautoclaim(settings.JOB_STREAM, settings.CONSUMER_GROUP, consumer,
                                       min_idle_time=settings.CLAIM_IDLE_MS, count=5)
        for message_id, fields in claimed[1]:
            handle(fields["job_id"])
            queue.r().xack(settings.JOB_STREAM, settings.CONSUMER_GROUP, message_id)

        # 3. new jobs
        messages = queue.r().xreadgroup(settings.CONSUMER_GROUP, consumer,
                                        {settings.JOB_STREAM: ">"}, count=1, block=2000)
        for _stream, entries in messages or []:
            for message_id, fields in entries:
                handle(fields["job_id"])
                queue.r().xack(settings.JOB_STREAM, settings.CONSUMER_GROUP, message_id)


if __name__ == "__main__":
    main()
