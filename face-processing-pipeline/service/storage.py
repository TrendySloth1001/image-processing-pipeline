"""Photos and videos live in S3/MinIO, so any worker on any machine can fetch them."""

import io
import os
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


class _Object(io.RawIOBase):
    """An object in the bucket, read like a local file: seek, read, repeat.

    A video is opened, not loaded. The decoder reads its header, jumps to the index — which in an
    MP4 is often at the very end — and then walks forward, so a reader that can seek turns a
    gigabyte file into a few megabytes of range requests and nothing on disk. boto3's own stream
    can only go forwards from the start, which is why this exists.
    """

    def __init__(self, key: str) -> None:
        self.key = key
        self.size = client().head_object(Bucket=settings.S3_BUCKET, Key=key)["ContentLength"]
        self.position = 0

    def readable(self) -> bool:
        return True

    def seekable(self) -> bool:
        return True

    def tell(self) -> int:
        return self.position

    def seek(self, offset: int, whence: int = os.SEEK_SET) -> int:
        base = {os.SEEK_SET: 0, os.SEEK_CUR: self.position, os.SEEK_END: self.size}[whence]
        self.position = max(0, min(self.size, base + offset))
        return self.position

    def readinto(self, buffer) -> int:
        wanted = min(len(buffer), self.size - self.position)
        if wanted <= 0:
            return 0
        last = self.position + wanted - 1
        data = client().get_object(Bucket=settings.S3_BUCKET, Key=self.key,
                                   Range=f"bytes={self.position}-{last}")["Body"].read()
        buffer[:len(data)] = data
        self.position += len(data)
        return len(data)


def open_object(key: str, chunk: int = 4 * 1024 * 1024) -> io.BufferedReader:
    """A seekable, buffered reader over one object. Reads the bucket `chunk` bytes at a time."""
    return io.BufferedReader(_Object(key), buffer_size=chunk)
