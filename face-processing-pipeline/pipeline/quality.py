"""Quality: decide which faces are good enough to trust.

Blurry, tiny or turned-away faces give unreliable embeddings. They can glue two different
people into one group, so only "strong" faces build groups; weak ones join afterwards.

What counts as tiny or blurry depends on where the face came from. A face filling a 12-megapixel
photo and a face thirty metres down a 720p video are not judged by the same numbers — see
`PHOTO` and `VIDEO` below.
"""

from dataclasses import dataclass

import cv2
import numpy as np

from pipeline.config import (MAX_YAW_RATIO, MIN_BLUR_SCORE, MIN_FACE_SIZE, STRONG_FACE_SIZE,
                             VIDEO_MIN_BLUR_SCORE, VIDEO_MIN_FACE_SIZE, VIDEO_STRONG_FACE_SIZE)
from pipeline.entities import Face


@dataclass(frozen=True)
class Bars:
    """The bars a face has to clear, for one kind of source."""

    min_size: float     # below this the face is ignored entirely
    strong_size: float  # at or above this (and sharp, and facing the camera) it can build groups
    min_blur: float
    max_yaw: float = MAX_YAW_RATIO


PHOTO = Bars(MIN_FACE_SIZE, STRONG_FACE_SIZE, MIN_BLUR_SCORE)
VIDEO = Bars(VIDEO_MIN_FACE_SIZE, VIDEO_STRONG_FACE_SIZE, VIDEO_MIN_BLUR_SCORE)


def face_size(face: Face) -> float:
    x1, y1, x2, y2 = face.bbox
    return float(min(x2 - x1, y2 - y1))

def blur_score(aligned: np.ndarray) -> float:
    gray = cv2.cvtColor(aligned, cv2.COLOR_BGR2GRAY)
    return float(cv2.Laplacian(gray,cv2.CV_64F).var())

def yaw_ratio(face: Face) -> float:
    left_eye,right_eye,nose = face.landmarks[0],face.landmarks[1],face.landmarks[2]
    eye_mid = (left_eye + right_eye)/2
    eye_axis = right_eye - left_eye
    eye_dist = float(np.linalg.norm(eye_axis))
    if eye_dist == 0:
        return 1.0
    offset = float(np.dot(nose - eye_mid , eye_axis)) / eye_dist
    return abs(offset)/eye_dist


def is_usable(face: Face, bars: Bars = PHOTO) -> bool:
    return face_size(face) >= bars.min_size


def score_face(face: Face, bars: Bars = PHOTO) -> None:
    size = face_size(face)
    blur = blur_score(face.aligned)
    yaw = yaw_ratio(face)
    face.yaw = yaw  # the consumer uses it to decide what may start a new person
    face.blur = blur  # and this to decide which face of somebody is worth showing
    face.is_strong = size >= bars.strong_size and blur >= bars.min_blur and yaw <= bars.max_yaw
    face.quality = face.det_score * min(size / bars.strong_size, 1.0) * (1 - min(yaw, 1.0))
