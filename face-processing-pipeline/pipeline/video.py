"""Video ingest: decode a video once and hand back a few frames a second.

A phone video is 30 frames a second, but a face does not change meaningfully between two frames
33 ms apart. Sampling at VIDEO_FPS shows the detector everyone who appears for a fraction of the
cost, and the frames that are skipped are never converted to pixels at all.
"""

import io
from contextlib import contextmanager
from dataclasses import dataclass

import av
import cv2
import numpy as np

from pipeline.config import (POSTER_MAX_SIDE, STILL_QUALITY, VIDEO_FPS, VIDEO_MAX_SECONDS,
                             VIDEO_MAX_SIDE)


@dataclass
class VideoInfo:
    width: int          # of the frames handed out, not of the file
    height: int
    source_width: int
    source_height: int
    duration_ms: int    # 0 when the container doesn't say
    source_fps: float


def _even(value: int) -> int:
    """libswscale wants even dimensions, and so does every chroma-subsampled format."""
    return max(2, int(round(value)) // 2 * 2)


def _scaled(width: int, height: int, max_side: int | None) -> tuple[int, int]:
    if not max_side or max(width, height) <= max_side:
        return _even(width), _even(height)
    ratio = max_side / max(width, height)
    return _even(width * ratio), _even(height * ratio)


def _frames(container, stream, size, fps: float, max_seconds: float):
    """Decode in order, keep about `fps` frames a second.

    Seeking to each wanted moment instead would make the decoder restart from the nearest
    keyframe every time, which costs more than decoding straight through whenever the sampling
    step is shorter than the keyframe interval — and at 2 fps it almost always is.
    """
    step = 1.0 / max(fps, 0.01)
    next_at = 0.0
    for frame in container.decode(stream):
        when = frame.time  # seconds, or None if the container gave no timestamp
        if when is None:
            continue
        if max_seconds and when > max_seconds:
            return
        if when + 1e-6 < next_at:
            continue
        next_at = when + step
        # reformat() scales and converts in libswscale, in one pass, before the pixels ever
        # reach numpy: much cheaper than converting the full frame and resizing it afterwards.
        yield int(when * 1000), frame.reformat(width=size[0], height=size[1],
                                               format="bgr24").to_ndarray()


@contextmanager
def open_video(source, fps: float = VIDEO_FPS, max_side: int | None = VIDEO_MAX_SIDE,
               max_seconds: float = VIDEO_MAX_SECONDS):
    """Open a video and yield (info, frames). `source` is a path or a seekable file object.

    The worker passes a file object that reads the video out of object storage in chunks, so a
    large file is never written to disk and only the parts the decoder asks for are fetched.
    """
    with av.open(source) as container:
        stream = container.streams.video[0]
        stream.thread_type = "AUTO"  # libavcodec decodes on every core it can use
        codec = stream.codec_context
        size = _scaled(codec.width, codec.height, max_side)
        average = stream.average_rate or stream.guessed_rate
        info = VideoInfo(
            width=size[0],
            height=size[1],
            source_width=codec.width,
            source_height=codec.height,
            duration_ms=int(float(stream.duration * stream.time_base) * 1000)
            if stream.duration and stream.time_base
            else (int(container.duration / av.time_base * 1000) if container.duration else 0),
            source_fps=float(average) if average else 0.0,
        )
        yield info, _frames(container, stream, size, fps, max_seconds)


def encode_jpeg(image: np.ndarray, max_side: int | None = None, quality: int = STILL_QUALITY) -> bytes:
    if max_side and max(image.shape[:2]) > max_side:
        scale = max_side / max(image.shape[:2])
        image = cv2.resize(image, (round(image.shape[1] * scale), round(image.shape[0] * scale)),
                           interpolation=cv2.INTER_AREA)
    ok, buffer = cv2.imencode(".jpg", image, [int(cv2.IMWRITE_JPEG_QUALITY), quality])
    if not ok:
        raise RuntimeError("could not encode frame as JPEG")
    return buffer.tobytes()


def poster(frame: np.ndarray) -> tuple[bytes, int, int]:
    """A still of the whole frame, used as the video's thumbnail."""
    data = encode_jpeg(frame, POSTER_MAX_SIDE)
    image = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    return data, image.shape[1], image.shape[0]


def frame_still(frame: np.ndarray) -> tuple[bytes, int, int]:
    """The whole frame, as it was sampled, as a JPEG.

    The obvious saving is to keep only a crop around the face, and that is what this did first.
    It costs nothing in the thumbnail — the consumer zooms into the same pixels either way — but
    it throws away the picture: you can see the face and never what was happening around it. The
    frame is kept whole instead, at the size it was decoded, and the consumer crops for a
    thumbnail and shows the whole thing when asked.

    It is affordable because frames are shared. Everybody on screen at one moment is one frame,
    and a face that keeps its slot for a hundred frames still only files the few it is kept for.
    """
    return encode_jpeg(frame), frame.shape[1], frame.shape[0]


def read_all(source) -> io.BytesIO:
    """For sources PyAV cannot stream from: pull the bytes into memory first."""
    return io.BytesIO(source.read() if hasattr(source, "read") else source)
