"""A stand-in consumer for testing: prints what arrives, checks the signature, acknowledges it.

FAIL_TIMES=2 rejects the first two attempts of every job, so the retry path can be exercised.
Run it with: uvicorn scripts.echo_webhook:app --host 0.0.0.0 --port 9000
"""

import hashlib
import hmac
import json
import os

from fastapi import FastAPI, Request, Response

SECRET = os.environ.get("WEBHOOK_SECRET", "dev-secret")
FAIL_TIMES = int(os.environ.get("FAIL_TIMES", "0"))
LOG_FILE = os.environ.get("WEBHOOK_LOG", "/tmp/received.jsonl")

app = FastAPI()
seen: dict[str, int] = {}


@app.post("/webhook")
async def webhook(request: Request):
    body = await request.body()
    job_id = request.headers.get("x-face-job-id", "?")
    attempt = int(request.headers.get("x-face-attempt", "0"))
    expected = "sha256=" + hmac.new(SECRET.encode(), body, hashlib.sha256).hexdigest()
    payload = json.loads(body)

    seen[job_id] = seen.get(job_id, 0) + 1
    # A photo delivers faces; a video delivers tracks, each holding a few faces, plus the count
    # at every stage of the funnel it came down.
    tracks = payload.get("tracks", [])
    first = (tracks[0]["faces"][0] if tracks and tracks[0]["faces"]
             else (payload["faces"][0] if payload.get("faces") else None))
    line = {
        "job_id": job_id,
        "attempt": attempt,
        "signature_ok": hmac.compare_digest(expected, request.headers.get("x-face-signature", "")),
        "kind": payload.get("kind", "image"),
        "status": payload.get("status"),
        "faces": len(payload.get("faces", [])) or sum(len(t["faces"]) for t in tracks),
        "tracks": len(tracks),
        "stages": payload.get("stages"),
        "still": first.get("still") if first else None,
        "embedding_length": len(first["embedding"]) if first else 0,
        "took_ms": payload.get("took_ms"),
        "metadata": payload.get("metadata"),
    }
    print(json.dumps(line), flush=True)
    with open(LOG_FILE, "a") as out:
        out.write(json.dumps(line) + "\n")

    if seen[job_id] <= FAIL_TIMES:
        return Response(status_code=500, content="not ready yet")
    return {"received": True}
