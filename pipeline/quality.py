"""Quality: decide which faces are good enough to trust.

Blurry, tiny or turned-away faces give unreliable embeddings. They can glue two different
people into one group, so only "strong" faces build groups; weak ones join afterwards.
"""

import cv2
import numpy as np

from pipeline.config import MAX_YAW_RATIO, MIN_BLUR_SCORE, MIN_FACE_SIZE, STRONG_FACE_SIZE
from pipeline.entities import Face


def face_size(face: Face) -> float:
    x1, y1, x2, y2 = face.bbox
    return float(max(x2 - x1, y2 - y1))

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


def is_usable(face: Face) -> bool:
    return face_size(face) >= MIN_FACE_SIZE


def score_face(face: Face) -> None:
    size = face_size(face)
    blur = blur_score(face.aligned)
    yaw = yaw_ratio(face)
    face.is_strong = size >= STRONG_FACE_SIZE and blur >= MIN_BLUR_SCORE and yaw <= MAX_YAW_RATIO
    face.quality = face.det_score * min(size / STRONG_FACE_SIZE ,0.1) * (1 - min(yaw,0.1))

