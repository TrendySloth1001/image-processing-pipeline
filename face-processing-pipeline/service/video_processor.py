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

from pipeline import detect, embed, gate as gates, quality, video
from pipeline.config import DETECTOR_MODEL, EMBEDDER_MODEL, TRACK_BY, VIDEO_FPS, VIDEO_GATE
from pipeline.track import Tracker
from service.processor import models

NO_FILE = Path("-")  # the pipeline works on frames in memory; nothing has a path


def _face_payload(face, extra: dict) -> dict:
    return {
        "det_score": round(float(face.det_score), 4),
        "quality": round(float(face.quality), 4),
        "is_strong": bool(face.is_strong),
        "yaw": round(float(face.yaw), 3),  # 0 = facing the camera
        "blur": round(float(face.blur), 1),  # higher = sharper
        "embedding": [round(float(v), 6) for v in face.embedding],
        **extra,
    }


def process_video(source, store, fps: float = VIDEO_FPS, log=lambda *a: None,
                  gate: str = VIDEO_GATE, track_by: str = TRACK_BY) -> dict:
    """`source` is a path or a seekable file object; `store(name, jpeg) -> key` files the stills.

    A funnel, narrowing at every stage: every frame in the file, then a few a second, then the
    ones the gate thinks are worth detecting on, then one record per person rather than one per
    sighting. The counts at each stage come back in the result so the shape of the funnel can be
    seen for a real video rather than assumed.
    """
    detector, embedder = models()
    started = time.time()
    tracker = Tracker(by=track_by)
    sampled = gated = detected = observations = 0
    poster = None

    keeper = gates.build(gate)
    with video.open_video(source, fps=fps) as (info, frames):
        for at_ms, frame in frames:
            if poster is None:
                poster = video.poster(frame)
            sampled += 1
            if not keeper.passes(frame):
                continue
            gated += 1
            found = detect.detect_faces(detector, frame, NO_FILE)
            detected += len(found)
            # Video's own size and blur bars: the photo ones discard faces that go on to match
            # their person perfectly well. Junk let in by the lower bars is caught later instead,
            # by having to survive more than one sampled frame.
            faces = [f for f in found if quality.is_usable(f, quality.VIDEO)]
            for face in faces:
                embed.align_face(frame, face)  # cheap, and quality needs the aligned crop
                quality.score_face(face, quality.VIDEO)
            observations += len(faces)
            keeper.report(len(faces))  # so a gate that rejected this frame can be caught out
            # Following a face by what it looks like needs an embedding for every sighting.
            # Following it by where it was does not, so that mode embeds at the end instead,
            # once per kept face rather than once per sighting.
            if track_by == "appearance":
                embed.embed_faces(embedder, faces)
            tracker.update(at_ms, faces, frame)
            if sampled % 50 == 0:
                log(f"  {at_ms / 1000:.0f}s: {sampled} sampled, {gated} detected on, "
                    f"{len(tracker.tracks)} tracks so far")

    tracks = tracker.finish(sampled)
    if track_by != "appearance":
        embed.embed_faces(embedder, [kept.face for track in tracks for kept in track.faces])
    poster_key = store("poster", poster[0]) if poster else None
    # One upload per moment, however many people were on screen in it.
    frames = {
        at_ms: {"key": store(f"frame{at_ms}", data), "width": width, "height": height}
        for at_ms, (data, width, height) in tracker.frames.items()
    }
    log(f"  {len(frames)} frame(s) filed for {sum(len(t.faces) for t in tracks)} kept face(s)")

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
        "detected": detected,  # every detection in every frame detected on, before tracking
        # The funnel, stage by stage: n -> sampled -> gated -> observations -> tracks -> faces.
        "stages": {
            "gate": keeper.name,
            "track_by": track_by,
            "sampled": sampled,
            "gated": gated,
            "observations": observations,
            "tracks": len(tracks),
            "faces": sum(len(t.faces) for t in tracks),
        },
        "tracks": [
            {
                "track": index,
                "first_ms": track.first_ms,
                "last_ms": track.last_ms,
                "frames": track.frames,  # sampled frames this person was seen in
                "faces": [
                    _face_payload(kept.face, {
                        "at_ms": kept.at_ms,
                        # The box is in the pixels of the frame filed with it, which is the whole
                        # frame as it was sampled: the consumer crops it for a thumbnail and shows
                        # all of it when somebody wants to see what was going on.
                        "bbox": [round(float(v), 2) for v in kept.face.bbox],
                        "still": frames[kept.at_ms],
                    })
                    for kept in track.faces
                ],
            }
            for index, track in enumerate(tracks)
        ],
        "took_ms": int((time.time() - started) * 1000),
    }
