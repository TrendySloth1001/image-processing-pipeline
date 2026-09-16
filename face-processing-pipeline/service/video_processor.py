"""Turn a video into tracks: who appears, when, and what their face looks like.

The photo processor answers "which faces are in this image". A video's unit is not a face but an
**appearance**: one person on screen from 0:12 to 0:41 is one thing to group, not eighty. So every
sampled frame is detected and embedded, the faces are joined into tracks, and each track delivers
a handful of representative faces. The consumer then treats a track exactly as it treats a photo's
face: match it against the people it already has, and put the whole track with that person.

Nothing is written to disk, and nothing is kept between jobs.
"""

import time
from pathlib import Path

from pipeline import detect, embed, quality, video
from pipeline.config import DETECTOR_MODEL, EMBEDDER_MODEL, VIDEO_FPS
from pipeline.track import Tracker
from service.processor import models

NO_FILE = Path("-")  # the pipeline works on frames in memory; nothing has a path


def _face_payload(face, extra: dict) -> dict:
    return {
        "det_score": round(float(face.det_score), 4),
        "quality": round(float(face.quality), 4),
        "is_strong": bool(face.is_strong),
        "yaw": round(float(face.yaw), 3),  # 0 = facing the camera
        "embedding": [round(float(v), 6) for v in face.embedding],
        **extra,
    }


def process_video(source, store, fps: float = VIDEO_FPS, log=lambda *a: None) -> dict:
    """`source` is a path or a seekable file object; `store(name, jpeg) -> key` files the stills."""
    detector, embedder = models()
    started = time.time()
    tracker = Tracker()
    sampled = detected = 0
    poster = None

    with video.open_video(source, fps=fps) as (info, frames):
        for at_ms, frame in frames:
            if poster is None:
                poster = video.poster(frame)
            found = detect.detect_faces(detector, frame, NO_FILE)
            detected += len(found)
            # Video's own size and blur bars: the photo ones discard faces that go on to match
            # their person perfectly well. Junk let in by the lower bars is caught later instead,
            # by having to survive more than one sampled frame.
            faces = [f for f in found if quality.is_usable(f, quality.VIDEO)]
            for face in faces:
                embed.align_face(frame, face)
                quality.score_face(face, quality.VIDEO)
            # Every face of the frame in one batch: the tracker needs embeddings to decide who
            # is who, and embedding costs a seventh of detecting, so there is nothing to save
            # by embedding lazily.
            embed.embed_faces(embedder, faces)
            tracker.update(at_ms, faces, frame)
            sampled += 1
            if sampled % 50 == 0:
                log(f"  {at_ms / 1000:.0f}s: {sampled} frames sampled, {len(tracker.tracks)} tracks so far")

    tracks = tracker.finish(sampled)
    poster_key = store("poster", poster[0]) if poster else None

    return {
        "kind": "video",
        "video": {
            "width": info.width,
            "height": info.height,
            "source_width": info.source_width,
            "source_height": info.source_height,
            "duration_ms": info.duration_ms,
            "sampled_frames": sampled,
            "sampled_fps": fps,
            "poster": {"key": poster_key, "width": poster[1], "height": poster[2]} if poster else None,
        },
        "detector": f"{type(detector).__name__} ({DETECTOR_MODEL.name})",
        "embedding_model": f"ArcFace ({EMBEDDER_MODEL.name})",
        "detected": detected,  # every detection in every sampled frame, before tracking
        "tracks": [
            {
                "track": index,
                "first_ms": track.first_ms,
                "last_ms": track.last_ms,
                "frames": track.frames,  # sampled frames this person was seen in
                "faces": [
                    _face_payload(kept.face, {
                        "at_ms": kept.at_ms,
                        # The box is in the still's pixels, not the video's: the still is what the
                        # consumer has to show, so that is the only frame of reference it needs.
                        "bbox": kept.still_bbox,
                        "still": {
                            "key": store(f"t{index}f{position}", kept.still),
                            "width": kept.still_width,
                            "height": kept.still_height,
                        },
                    })
                    for position, kept in enumerate(track.faces)
                ],
            }
            for index, track in enumerate(tracks)
        ],
        "took_ms": int((time.time() - started) * 1000),
    }
