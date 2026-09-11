"""Quality: decide which faces are good enough to trust.

Blurry, tiny or turned-away faces give unreliable embeddings. They can glue two different
people into one group, so only "strong" faces build groups; weak ones join afterwards.
"""

import cv2
import numpy as np

from pipeline.config import MAX_YAW_RATIO, MIN_BLUR_SCORE, MIN_FACE_SIZE, STRONG_FACE_SIZE
from pipeline.entities import Face


def face_size(face: Face) -> float:
    """Shorter side of the face box, in pixels."""
    # 1. Unpack x1, y1, x2, y2 from face.bbox.
    # 2. Return min(x2 - x1, y2 - y1) as a float.
    raise NotImplementedError


def blur_score(aligned: np.ndarray) -> float:
    """Sharpness of a 112 x 112 aligned crop. Higher = sharper."""
    # 1. Convert to grayscale: cv2.cvtColor(aligned, cv2.COLOR_BGR2GRAY).
    # 2. Run cv2.Laplacian(gray, cv2.CV_64F); it lights up on edges.
    # 3. Return .var() of the result as a float. Blurry faces have few edges, so low variance.
    raise NotImplementedError


def yaw_ratio(face: Face) -> float:
    """How far the head is turned left or right, from the landmarks. 0 = looking straight."""
    # 1. left_eye, right_eye, nose = face.landmarks[0], face.landmarks[1], face.landmarks[2]
    # 2. eye_mid_x = average of the two eyes' x; eye_dist = abs(right_eye x - left_eye x).
    # 3. If eye_dist is 0, return a big number (e.g. 1.0): the face is fully sideways.
    # 4. Return abs(nose x - eye_mid_x) / eye_dist. Turning the head moves the nose toward one eye.
    raise NotImplementedError


def is_usable(face: Face) -> bool:
    """False for faces too small to use at all (background strangers, noise)."""
    # 1. Return face_size(face) >= MIN_FACE_SIZE.
    raise NotImplementedError


def score_face(face: Face) -> None:
    """Fill face.quality and face.is_strong. Needs face.aligned, so run embed.align_face first."""
    # 1. Compute size = face_size(face), blur = blur_score(face.aligned), yaw = yaw_ratio(face).
    # 2. face.is_strong = size >= STRONG_FACE_SIZE and blur >= MIN_BLUR_SCORE and yaw <= MAX_YAW_RATIO
    # 3. face.quality = one number to rank faces of the same person (picks the cover face).
    #    A simple start: face.det_score * min(size / STRONG_FACE_SIZE, 1.0) * (1 - min(yaw, 1.0))
    raise NotImplementedError
