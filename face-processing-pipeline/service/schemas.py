"""What the producer sends in and what the consumer gets back."""

from typing import Any

from pydantic import BaseModel, Field, model_validator


class MediaRef(BaseModel):
    key: str | None = None  # object already in the bucket
    url: str | None = None  # or any URL the worker can fetch

    @model_validator(mode="after")
    def exactly_one(self):
        if bool(self.key) == bool(self.url):
            raise ValueError("give exactly one of key or url")
        return self


ImageRef = MediaRef  # the name the first version of the API used


class JobRequest(BaseModel):
    """One photo or one video. `image` and `video` are the same shape; which one you fill in
    decides what the worker does and what shape the result takes."""

    image: MediaRef | None = None
    video: MediaRef | None = None
    callback_url: str  # where the result is delivered, retried until it answers 2xx
    metadata: dict[str, Any] = Field(default_factory=dict)  # echoed back untouched

    @model_validator(mode="after")
    def exactly_one_medium(self):
        if bool(self.image) == bool(self.video):
            raise ValueError("give exactly one of image or video")
        return self

    @property
    def kind(self) -> str:
        return "video" if self.video else "image"

    @property
    def media(self) -> MediaRef:
        return self.video or self.image  # type: ignore[return-value]


class JobAccepted(BaseModel):
    job_id: str
    kind: str
    status: str


class Face(BaseModel):
    bbox: list[float]  # x1, y1, x2, y2; in the image's pixels, or in the still's for a video face
    landmarks: list[list[float]] | None = None  # 5 points: eyes, nose, mouth corners
    det_score: float
    quality: float
    is_strong: bool
    yaw: float  # how far the head is turned; 0 = looking straight at the camera
    embedding: list[float]  # 512 numbers, length 1
    at_ms: int | None = None  # video only: when in the video this face was seen
    still: dict[str, Any] | None = None  # video only: {key, width, height} of its JPEG


class Track(BaseModel):
    """One person's continuous appearance in a video, as a few representative faces."""

    track: int
    first_ms: int
    last_ms: int
    frames: int  # sampled frames the person was seen in
    faces: list[Face]  # best first


class Result(BaseModel):
    """The webhook body. `status` is "succeeded" or "failed"; on failure `error` says why.

    `kind` is "image" (faces) or "video" (tracks, each holding faces).
    """

    job_id: str
    kind: str = "image"
    status: str
    metadata: dict[str, Any] = Field(default_factory=dict)
    image: dict[str, int] | None = None  # width, height after rotation
    video: dict[str, Any] | None = None  # size, duration, how it was sampled, poster
    detector: str | None = None
    embedding_model: str | None = None
    detected: int | None = None  # detections before filtering; for a video, across every frame
    faces: list[Face] = Field(default_factory=list)  # images
    tracks: list[Track] = Field(default_factory=list)  # videos
    took_ms: int | None = None
    error: str | None = None
