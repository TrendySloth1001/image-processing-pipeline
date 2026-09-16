"""Align + embed: turn each face into 512 numbers with ArcFace.

Two faces of the same person give similar numbers; different people give different ones.
"""

import numpy as np
from insightface.model_zoo.arcface_onnx import ArcFaceONNX
from insightface.utils import face_align

from pipeline.config import EMBEDDER_MODEL
from pipeline.entities import Face
from pipeline.onnx import session as onnx_session


def load_embedder() -> ArcFaceONNX:
    return ArcFaceONNX(model_file=str(EMBEDDER_MODEL), session=onnx_session(str(EMBEDDER_MODEL)))


def align_face(image: np.ndarray, face: Face) -> None:
    face.aligned = face_align.norm_crop(image, landmark=face.landmarks, image_size=112)

def embed_faces(embedder: ArcFaceONNX, faces: list[Face]) -> None:
    if not faces:
        return
    feats = embedder.get_feat([f.aligned for f in faces])
    feats = feats / np.linalg.norm(feats, axis=1, keepdims=True)  # L2 normalize
    for face, feat in zip(faces,feats):
        face.embedding = feat