"""What the producer sends in and what the consumer gets back."""

from typing import Any

from pydantic import BaseModel, Field, model_validator


class ImageRef(BaseModel):
    key: str | None = None  # object already in the bucket
    url: str | None = None  # or any URL the worker can fetch

    @model_validator(mode="after")
    def exactly_one(self):
        if bool(self.key) == bool(self.url):
            raise ValueError("give exactly one of image.key or image.url")
        return self


class JobRequest(BaseModel):
    image: ImageRef
    callback_url: str  # where the result is delivered, retried until it answers 2xx
    metadata: dict[str, Any] = Field(default_factory=dict)  # echoed back untouched


class JobAccepted(BaseModel):
    job_id: str
    status: str


class Face(BaseModel):
    bbox: list[float]  # x1, y1, x2, y2 in pixels of the image as delivered
    landmarks: list[list[float]]  # 5 points: eyes, nose, mouth corners
    det_score: float
    quality: float
    is_strong: bool
    embedding: list[float]  # 512 numbers, length 1


class Result(BaseModel):
    """The webhook body. `status` is "succeeded" or "failed"; on failure `error` says why."""

    job_id: str
    status: str
    metadata: dict[str, Any] = Field(default_factory=dict)
    image: dict[str, int] | None = None  # width, height after rotation
    detector: str | None = None
    embedding_model: str | None = None
    detected: int | None = None  # faces before the size filter
    faces: list[Face] = Field(default_factory=list)
    took_ms: int | None = None
    error: str | None = None
