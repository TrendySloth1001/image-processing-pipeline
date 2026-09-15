# Face processing

A stateless face-processing microservice (queue in, webhook out) and a Next.js app that uses it.
Everything runs in Docker; nothing is installed on the Mac.

```
face-processing-pipeline/   Python service
  service/                  the microservice: producer API, worker, queue, storage, webhook delivery
  pipeline/                  the processing core: SCRFD detection, ArcFace embeddings, grouping
  web/                       folder-based test UI, a development helper (http://localhost:8000)
  scripts/                   check_env.py, echo_webhook.py
  data/                      photos in, results out, for the folder-based UI (never committed)
frontend/                   Next.js app (http://localhost:3000)
compose.yaml                api + worker + frontend + Redis + MinIO + Postgres
```

## Run it

```sh
docker compose build app
docker compose up -d api worker frontend          # Redis, MinIO and Postgres start with them
docker compose up -d --scale worker=3 worker      # more consumers, same queue
```

| What | Where |
|---|---|
| Producer API (docs) | http://localhost:8080/docs |
| Next.js app | http://localhost:3000 |
| MinIO console | http://localhost:9001 (minioadmin / minioadmin) |
| Folder-based test UI | http://localhost:8000 |

## The microservice

```mermaid
flowchart TD
    A[Your app - producer] -->|POST /v1/jobs + callback_url| B[api]
    B -->|photo| C[(MinIO)]
    B -->|job id| D[[Redis stream face:jobs]]
    D --> W[worker - stateless, N replicas]
    C -.fetch.-> W
    W -->|POST signed result| E[Your webhook - consumer]
    E -->|2xx acknowledges| W
    W -->|no ack: 0s, 5s, 30s, 2m, 10m, 30m, 1h, 2h| E
```

The service keeps no data of its own: no results table, no per-run state. A job carries everything
the worker needs, and the result goes straight to the caller's webhook. Job bookkeeping and the
pending result live in Redis, so any worker can take over any job.

### Submit a job

```sh
# photo already in the bucket, or any URL the worker can fetch
curl -X POST localhost:8080/v1/jobs -H 'content-type: application/json' -d '{
  "image": {"key": "incoming/abc.jpg"},
  "callback_url": "http://your-app:3000/api/webhooks/faces",
  "metadata": {"photo_id": "p_123"}
}'

# or hand over the bytes and let the API store them
curl -F file=@photo.jpg -F callback_url=http://your-app:3000/api/webhooks/faces \
     -F 'metadata={"photo_id":"p_123"}' localhost:8080/v1/jobs/upload
```

Both answer `202 {"job_id": "job_…", "status": "queued"}`.
`GET /v1/jobs/{job_id}` reports `queued → processing → delivering → delivered`, or `dead` if the
consumer never acknowledged, along with the attempt count and the last error.

### Receive the result

The worker POSTs this to `callback_url`:

```json
{
  "job_id": "job_f142d02582ae4917bdf8",
  "status": "succeeded",
  "metadata": {"photo_id": "p_123"},
  "image": {"width": 1280, "height": 886},
  "detector": "SCRFD (det_10g.onnx)",
  "embedding_model": "ArcFace (w600k_r50.onnx)",
  "detected": 6,
  "faces": [{"bbox": [...], "landmarks": [[x, y], ...], "det_score": 0.92,
             "quality": 0.81, "is_strong": true, "embedding": [512 numbers]}],
  "took_ms": 1600
}
```

On failure it delivers `{"status": "failed", "error": "..."}` for the same job, so the producer
always hears back. Headers: `x-face-job-id`, `x-face-attempt`, and `x-face-signature`, an
HMAC-SHA256 of the exact body with `WEBHOOK_SECRET`. Verify it before trusting the payload:

```ts
const expected = "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
const signature = request.headers.get("x-face-signature") ?? "";
const ok = expected.length === signature.length &&
           crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
```

**Acknowledgement.** Any 2xx closes the job. Anything else, including a timeout, is retried on the
schedule above; the computed result waits in Redis, so a retry re-sends rather than re-processes.
After the last attempt the job is marked `dead` and its id is pushed to the `face:deliveries:dead`
list. Delivery is at-least-once, so treat `job_id` as an idempotency key on your side.

### Settings

`REDIS_URL`, `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `WEBHOOK_SECRET`,
`WEBHOOK_TIMEOUT`, `RETRY_SCHEDULE` (comma-separated seconds), `RESULT_TTL`, `CLAIM_IDLE_MS`.
Defaults are in `service/settings.py`.

## The app (frontend)

```
browser → POST /api/upload → MinIO + POST /v1/jobs → queue → worker
                                                              ↓ signed result
        gallery database ← POST /api/webhooks/faces ←──────────┘
```

The app owns its `gallery` database (Postgres + pgvector, created by the `db-init` service);
the pipeline never touches it.

| Table | What's in it |
|---|---|
| `photos` | object key, file name, job id, status, width/height, error |
| `faces` | photo id, person id, bbox, det_score, quality, is_strong, `vector(512)` embedding |
| `people` | just an id, which faces point at |

Tables and the HNSW cosine index are created on first use by `ensureSchema()` in
`src/db/index.ts`, so there is no migration tool to run.

**Grouping happens twice over.** On arrival, the webhook stores each face and finds its nearest
neighbour in pgvector (`embedding <=> $1`), ignoring faces from the same photo: above 0.45
similarity it joins that person, while a weak face needs 0.5 and never starts a new person, so
people appear seconds after an upload. On demand, **Regroup everything** re-clusters the library
with average linkage the way the batch pipeline does, which repairs groups that drifted apart. It
renumbers people, so person URLs change after a regroup.

**Webhook safety:** every delivery is checked against the HMAC signature (401 otherwise), and the
handler is idempotent — it replaces a photo's faces instead of appending, because the pipeline
retries until it gets a 2xx.

Settings are in `src/lib/config.ts`: `DATABASE_URL`, `PIPELINE_URL`, `CALLBACK_URL`,
`WEBHOOK_SECRET`, `S3_*`, and the two thresholds `SAME_FACE` and `ATTACH_FACE`.

## The processing core

```
load image (fix rotation) → SCRFD detect → drop tiny faces → align to 112×112 → quality score
→ ArcFace embedding
```

| Module | What it does |
|---|---|
| `pipeline/ingest.py` | Loads a photo from a path or from bytes, the right way up (EXIF, HEIC). |
| `pipeline/detect.py` | SCRFD-10GF: face boxes and 5 landmarks. |
| `pipeline/quality.py` | Size, blur and head angle; marks a face strong or weak. |
| `pipeline/embed.py` | Aligns each face and turns it into 512 ArcFace numbers. |
| `pipeline/cluster.py` | Groups strong faces, attaches weak ones, numbers people by photo count. |
| `pipeline/db.py`, `export.py` | Used only by the folder-based test UI, not by the microservice. |

## Development helpers

**Folder-based UI** (http://localhost:8000): drop photos in, press **Run pipeline**, and browse the
people it found. Every step appears in the Processing panel on the right; **Face boxes** shows each
photo with its faces boxed and numbered. It writes `data/output/` and uses Postgres, which the
microservice does not.

**Command line:** `docker compose run --rm app python -m pipeline.run` for the folder pipeline, and
`docker compose run --rm app python scripts/check_env.py` to check models and database.

**Stand-in consumer:** `scripts/echo_webhook.py` prints deliveries, verifies the signature and
acknowledges them; `FAIL_TIMES=2` makes it reject the first two attempts so retries can be tested.

**Editor:** open the project with **Dev Containers: Reopen in Container**. VS Code then runs inside
the app container, so imports resolve without installing anything on the Mac. It opens
`face-processing-pipeline/`; edit `frontend/` in a normal window.

## Tuning the grouping

In `pipeline/config.py`: raise `CLUSTER_DISTANCE` if one person is split across groups, lower it if
different people are mixed together; `MIN_PHOTOS_PER_PERSON` is 1 while testing so everyone shows.
The same person photographed as a child, or in black and white, scores far below the same-person
range and needs a manual merge rather than a looser threshold.

## Notes

- Docker on a Mac can't use the GPU, so everything runs on the CPU: a few photos per second.
- InsightFace's pretrained SCRFD/ArcFace weights (buffalo_l) are for non-commercial research only.
