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
    line = {
        "job_id": job_id,
        "attempt": attempt,
        "signature_ok": hmac.compare_digest(expected, request.headers.get("x-face-signature", "")),
        "status": payload.get("status"),
        "faces": len(payload.get("faces", [])),
        "embedding_length": len(payload["faces"][0]["embedding"]) if payload.get("faces") else 0,
        "metadata": payload.get("metadata"),
    }
    print(json.dumps(line), flush=True)
    with open(LOG_FILE, "a") as out:
        out.write(json.dumps(line) + "\n")

    if seen[job_id] <= FAIL_TIMES:
        return Response(status_code=500, content="not ready yet")
    return {"received": True}
