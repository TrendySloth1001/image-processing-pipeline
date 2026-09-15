"""Photos live in S3/MinIO, so any worker on any machine can fetch them."""

import time

import boto3
from botocore.client import Config
from botocore.exceptions import ClientError

from service import settings

_client = None


def client():
    global _client
    if _client is None:
        _client = boto3.client(
            "s3",
            endpoint_url=settings.S3_ENDPOINT,
            aws_access_key_id=settings.S3_ACCESS_KEY,
            aws_secret_access_key=settings.S3_SECRET_KEY,
            region_name=settings.S3_REGION,
            config=Config(signature_version="s3v4", retries={"max_attempts": 3}),
        )
    return _client


def ensure_bucket(attempts: int = 30) -> None:
    """Create the bucket if it isn't there, waiting for storage to come up on a cold start."""
    for attempt in range(attempts):
        try:
            client().head_bucket(Bucket=settings.S3_BUCKET)
            return
        except ClientError:
            client().create_bucket(Bucket=settings.S3_BUCKET)
            return
        except Exception:  # storage not listening yet
            if attempt == attempts - 1:
                raise
            time.sleep(1)


def put_bytes(key: str, data: bytes, content_type: str = "application/octet-stream") -> str:
    client().put_object(Bucket=settings.S3_BUCKET, Key=key, Body=data, ContentType=content_type)
    return key


def get_bytes(key: str) -> bytes:
    return client().get_object(Bucket=settings.S3_BUCKET, Key=key)["Body"].read()
