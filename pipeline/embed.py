"""Align + embed: turn each face into 512 numbers with ArcFace.

Two faces of the same person give similar numbers; different people give different ones.
"""

import numpy as np
from insightface.model_zoo import get_model
from insightface.model_zoo.arcface_onnx import ArcFaceONNX
from insightface.utils import face_align

from pipeline.config import EMBEDDER_MODEL
from pipeline.entities import Face


def load_embedder() -> ArcFaceONNX:
    embedder = get_model(str(EMBEDDER_MODEL), providers=["CPUExecutionProvider"])
    return embedder


def align_face(image: np.ndarray, face: Face) -> None:
    face.aligned = face_align.norm_crop(image, landmarks=face.landmarks, image_size=112)

def embed_faces(embedder: ArcFaceONNX, faces: list[Face]) -> None:
    if not faces:
        return
    feats = embedder.get_feat([if.aligned for f in faces])
    feats = feats / np.linalg.norm(feats, axis=1, keepdims=True)  # L2 normalize
    for face, feat in zip(faces,feats):
        face.embedding = feat