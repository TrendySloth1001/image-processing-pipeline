"""Track: tie one face across sampled frames into a single appearance.

A person on screen for twenty seconds is the same person in forty sampled frames. Delivering
forty near-identical faces would give the consumer forty chances to group them wrongly and forty
rows for one appearance, so the frames are joined into a **track** and the track delivers only a
few representative faces: the best one, plus the ones that look different enough to be worth
keeping (a turned head, a different light).

Matching is by embedding first and position second. At two frames a second a walking person moves
further than their own face between samples, so boxes overlapping is weak evidence; the face
itself is strong evidence. Position is still used to rescue a face whose embedding went noisy in
a blurred frame but that plainly stayed where it was.
"""

from dataclasses import dataclass, field

import numpy as np

from pipeline.config import (MIN_TRACK_FRAMES, TRACK_FACES, TRACK_IOU, TRACK_MAX_GAP_MS,
                             TRACK_NEAR_FACE, TRACK_REDUNDANT, TRACK_SAME_FACE)
from pipeline.entities import Face
from pipeline.video import frame_still


@dataclass
class Kept:
    """One representative face of a track, and the moment it was seen.

    The picture itself lives in the tracker's `frames`, keyed by that moment, because everybody
    on screen at once shares one frame and a face that holds its slot for a hundred frames still
    only files the few it is kept for. The frame is encoded when a face first wins a slot rather
    than at the end, since holding raw 720p frames would be the largest thing in memory by far.
    """

    face: Face
    at_ms: int


@dataclass
class Track:
    id: int
    first_ms: int
    last_ms: int
    frames: int = 0
    faces: list[Kept] = field(default_factory=list)  # best first, once finished
    mean: np.ndarray | None = None  # average of every embedding seen, length 1
    last: np.ndarray | None = None  # the most recent embedding
    last_box: np.ndarray | None = None
    seen_at: int = -1  # the frame this track was last matched in, so it takes only one face a frame

    @property
    def quality(self) -> float:
        return max((kept.face.quality for kept in self.faces), default=0.0)

    def similarity(self, embedding: np.ndarray) -> float:
        """Against the average face and against the last one: whichever agrees more.

        The average is steady over a long appearance; the last frame follows a head that is
        turning away, which the average is always a few frames behind.
        """
        return max(float(embedding @ self.mean), float(embedding @ self.last))

    def _absorb(self, face: Face, at_ms: int, frame_index: int) -> None:
        weight = self.frames
        self.mean = (self.mean * weight + face.embedding) / (weight + 1)
        self.mean = self.mean / np.linalg.norm(self.mean)
        self.last = face.embedding
        self.last_box = face.bbox
        self.last_ms = at_ms
        self.frames += 1
        self.seen_at = frame_index

    def _offer(self, face: Face, at_ms: int, frame: np.ndarray, remember) -> None:
        """Decide whether this face earns one of the track's few representative slots.

        A face that looks almost the same as one already kept is not worth a slot; it only takes
        that one's place if it is better. Otherwise the worst-quality slot gives way.
        """
        twin, closest = -1, TRACK_REDUNDANT
        for index, kept in enumerate(self.faces):
            agreement = float(face.embedding @ kept.face.embedding)
            if agreement >= closest:
                twin, closest = index, agreement

        if twin >= 0:
            if face.quality > self.faces[twin].face.quality:
                self.faces[twin] = Kept(face, at_ms)
                remember(at_ms, frame)
            return
        if len(self.faces) < TRACK_FACES:
            self.faces.append(Kept(face, at_ms))
            remember(at_ms, frame)
            return
        worst = min(range(len(self.faces)), key=lambda i: self.faces[i].face.quality)
        if face.quality > self.faces[worst].face.quality:
            self.faces[worst] = Kept(face, at_ms)
            remember(at_ms, frame)


def iou(a: np.ndarray, b: np.ndarray) -> float:
    """How much two boxes overlap, 0 to 1."""
    x1, y1 = max(a[0], b[0]), max(a[1], b[1])
    x2, y2 = min(a[2], b[2]), min(a[3], b[3])
    overlap = max(0.0, float(x2 - x1)) * max(0.0, float(y2 - y1))
    if overlap == 0.0:
        return 0.0
    areas = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1])
    return overlap / float(areas - overlap)


class Tracker:
    """Feed it the faces of each sampled frame in order; ask it for the tracks at the end."""

    def __init__(self) -> None:
        self.tracks: list[Track] = []
        self.frame_index = -1
        self.frames: dict[int, tuple[bytes, int, int]] = {}  # moment -> the whole frame, as a JPEG

    def _remember(self, at_ms: int, frame: np.ndarray) -> None:
        if at_ms not in self.frames:
            self.frames[at_ms] = frame_still(frame)

    def update(self, at_ms: int, faces: list[Face], frame: np.ndarray) -> None:
        self.frame_index += 1
        # Best matches first, so a confident face claims its track before a doubtful one can.
        order = sorted(range(len(faces)), key=lambda i: -faces[i].quality)
        for index in order:
            face = faces[index]
            track = self._best_match(face, at_ms)
            if track is None:
                track = Track(id=len(self.tracks), first_ms=at_ms, last_ms=at_ms,
                              mean=face.embedding.copy(), last=face.embedding)
                self.tracks.append(track)
            track._absorb(face, at_ms, self.frame_index)
            track._offer(face, at_ms, frame, self._remember)

    def _best_match(self, face: Face, at_ms: int) -> Track | None:
        best, score = None, 0.0
        for track in self.tracks:
            if track.seen_at == self.frame_index:
                continue  # one track takes at most one face per frame: two faces are two people
            if at_ms - track.last_ms > TRACK_MAX_GAP_MS:
                continue  # gone long enough that this is a fresh appearance, not the same one
            agreement = track.similarity(face.embedding)
            overlap = iou(face.bbox, track.last_box)
            same = agreement >= TRACK_SAME_FACE or (overlap >= TRACK_IOU and agreement >= TRACK_NEAR_FACE)
            if same and agreement > score:
                best, score = track, agreement
        return best

    def finish(self, sampled_frames: int = 0) -> list[Track]:
        """Drop the flickers and put each track's best face first.

        A face that appears in a single sampled frame and never again is usually not a face at
        all — this is accuracy a video gives for free, because a false detection rarely survives
        half a second. It also drops someone who walked through one frame of the background,
        which is exactly who a gallery should not be making a person out of.

        The rule is relaxed for a video too short to have offered a second look: asking a face to
        be seen twice in a clip with one sampled frame would throw away everyone in it.
        """
        floor = MIN_TRACK_FRAMES if sampled_frames > MIN_TRACK_FRAMES else 1
        kept = [t for t in self.tracks if t.frames >= floor and t.faces]
        for track in kept:
            track.faces.sort(key=lambda k: -k.face.quality)
        kept.sort(key=lambda t: (t.first_ms, t.id))
        # Frames whose only claimant lost its slot, or whose track turned out to be a flicker,
        # are nobody's picture now.
        wanted = {face.at_ms for track in kept for face in track.faces}
        self.frames = {at_ms: frame for at_ms, frame in self.frames.items() if at_ms in wanted}
        return kept
