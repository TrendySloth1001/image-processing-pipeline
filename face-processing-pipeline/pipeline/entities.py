"""Data passed between pipeline stages. Each stage fills in more fields of Face."""

from dataclasses import dataclass
from pathlib import Path

import numpy as np


@dataclass
class Face:
    # Filled by detect.detect_faces
    photo_path: Path        # which photo this face came from
    bbox: np.ndarray        # [x1, y1, x2, y2] in photo pixels
    det_score: float        # SCRFD confidence, 0..1
    landmarks: np.ndarray   # 5 x 2: left eye, right eye, nose, left mouth, right mouth (image left/right)

    # Filled by embed.align_face / embed.embed_faces
    aligned: np.ndarray | None = None    # 112 x 112 BGR crop, face warped to a standard pose
    embedding: np.ndarray | None = None  # 512 numbers, length 1 (L2-normalized)

    # Filled by quality.score_face
    quality: float = 0.0    # higher = better; used to pick each person's cover face
    is_strong: bool = False  # True = trustworthy enough to build groups from

    # Filled by db.save_photo_faces / cluster.py
    db_id: int | None = None      # row id in the faces table
    person_id: int | None = None  # None = not assigned to anyone ("unsorted")
