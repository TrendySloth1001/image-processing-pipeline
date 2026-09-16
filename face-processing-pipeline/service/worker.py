"""Consumer side: take a job off the stream, find the faces, deliver the result.

Run several of these: `docker compose up -d --scale worker=3`. They share one consumer group,
so each job goes to exactly one worker, and a job left unacked by a crashed worker is claimed
by another after CLAIM_IDLE_MS.
"""

import json
import os
import socket
import time

import httpx

from pipeline.config import VIDEO_READ_CHUNK
from pipeline.video import read_all
from service import delivery, queue, settings, storage
from service.processor import models, process
from service.video_processor import process_video


def fetch(media: dict) -> bytes:
    if media.get("key"):
        return storage.get_bytes(media["key"])
    response = httpx.get(media["url"], timeout=30, follow_redirects=True)
    response.raise_for_status()
    return response.content


def open_video_source(media: dict):
    """A video is opened rather than loaded: the decoder reads the header, jumps to the index and
    walks forward, so a file in the bucket costs a few range requests instead of its whole size.
    A video behind a plain URL has to be pulled into memory, because the decoder must be able to
    seek and an HTTP response cannot."""
    if media.get("key"):
        return storage.open_object(media["key"], VIDEO_READ_CHUNK)
    response = httpx.get(media["url"], timeout=120, follow_redirects=True)
    response.raise_for_status()
    return read_all(response.content)


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
    kind = job.get("kind", "image")
    media = job.get("media") or job.get("image")  # "image" is what the first version sent
    queue.set_state(job_id, status="processing")
    started = time.time()
    try:
        if kind == "video":
            # Stills go next to the job in the bucket, so the consumer can show a face from a
            # video without holding the video itself, and so a reset can delete them by prefix.
            def store(name: str, jpeg: bytes) -> str:
                return storage.put_bytes(f"stills/{job_id}/{name}.jpg", jpeg, "image/jpeg")

            result = {"status": "succeeded", **process_video(open_video_source(media), store,
                                                             log=lambda line: log(f"job {job_id}: {line}"))}
            faces = sum(len(track["faces"]) for track in result["tracks"])
            log(f"job {job_id}: {len(result['tracks'])} track(s) and {faces} face(s) from "
                f"{result['video']['sampled_frames']} sampled frames "
                f"({result['detected']} detections) in {result['took_ms']}ms")
        else:
            result = {"status": "succeeded", **process(fetch(media))}
            log(f"job {job_id}: {len(result['faces'])} face(s) of {result['detected']} detected "
                f"in {result['took_ms']}ms")
    except Exception as e:
        result = {"status": "failed", "kind": kind, "error": f"{type(e).__name__}: {e}"}
        log(f"job {job_id}: failed after {int((time.time() - started) * 1000)}ms ({result['error']})")

    result = {"job_id": job_id, "kind": kind, "metadata": job.get("metadata", {}), **result}
    delivery.store_result(job_id, result)
    queue.set_state(job_id, faces=len(result.get("faces", [])), tracks=len(result.get("tracks", [])))
    delivery.schedule(job_id, attempt=0)  # first attempt is immediate


def main() -> None:
    storage.ensure_bucket()
    queue.ensure_group()
    # Every container's main process is PID 1, so the name needs the hostname (the container id)
    # to stay unique. Two consumers sharing a name share their pending list, and then a crashed
    # worker's job is never reclaimed.
    consumer = os.environ.get("CONSUMER_NAME") or f"{socket.gethostname()}-{os.getpid()}"
    print("loading SCRFD and ArcFace…", flush=True)
    models()
    print(f"{consumer} ready: stream {settings.JOB_STREAM}, group {settings.CONSUMER_GROUP}", flush=True)

    while True:
        # 1. deliveries that are due (first attempts and retries), claimed so no other worker sends them
        for job_id in delivery.claim_due():
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
