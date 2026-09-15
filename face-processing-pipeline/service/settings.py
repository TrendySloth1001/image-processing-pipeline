"""Everything the service reads from the environment, with local-development defaults."""

import os

# --- Queue ---
REDIS_URL = os.environ.get("REDIS_URL", "redis://redis:6379/0")
JOB_STREAM = os.environ.get("JOB_STREAM", "face:jobs")
CONSUMER_GROUP = os.environ.get("CONSUMER_GROUP", "workers")
CLAIM_IDLE_MS = int(os.environ.get("CLAIM_IDLE_MS", "60000"))  # take over a job this long unacked

# --- Object storage (MinIO locally, S3 in production) ---
S3_ENDPOINT = os.environ.get("S3_ENDPOINT", "http://minio:9000")
S3_BUCKET = os.environ.get("S3_BUCKET", "faces")
S3_ACCESS_KEY = os.environ.get("S3_ACCESS_KEY", "minioadmin")
S3_SECRET_KEY = os.environ.get("S3_SECRET_KEY", "minioadmin")
S3_REGION = os.environ.get("S3_REGION", "us-east-1")

# --- Webhook delivery ---
WEBHOOK_SECRET = os.environ.get("WEBHOOK_SECRET", "dev-secret")  # signs every delivery
WEBHOOK_TIMEOUT = float(os.environ.get("WEBHOOK_TIMEOUT", "10"))
# Seconds to wait before each attempt: the first is immediate, then it backs off to 2 hours.
# After the last one the job is dead-lettered instead of being retried forever.
RETRY_SCHEDULE = [int(s) for s in os.environ.get("RETRY_SCHEDULE", "0,5,30,120,600,1800,3600,7200").split(",")]
RESULT_TTL = int(os.environ.get("RESULT_TTL", str(24 * 3600)))  # keep a result this long for retries
