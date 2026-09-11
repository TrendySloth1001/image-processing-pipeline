"""Smoke test: SCRFD + ArcFace run inside the container and Postgres has pgvector."""

import os

import onnxruntime
import psycopg
from insightface.app import FaceAnalysis
from insightface.data import get_image


def check_models() -> None:
    app = FaceAnalysis(
        name="buffalo_l",
        root=os.environ["MODELS_DIR"],
        allowed_modules=["detection", "recognition"],
        providers=["CPUExecutionProvider"],
    )
    app.prepare(ctx_id=-1, det_size=(640, 640))
    faces = app.get(get_image("t1"))  # group photo bundled with insightface
    assert faces, "SCRFD found no faces in the sample image"
    print(f"onnxruntime {onnxruntime.__version__}, providers {onnxruntime.get_available_providers()}")
    print(f"SCRFD found {len(faces)} faces; ArcFace embedding dim {faces[0].normed_embedding.shape[0]}")


def check_db() -> None:
    with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
        conn.execute("CREATE EXTENSION IF NOT EXISTS vector")
        (version,) = conn.execute("SELECT extversion FROM pg_extension WHERE extname = 'vector'").fetchone()
        print(f"Postgres OK, pgvector {version}")


if __name__ == "__main__":
    check_models()
    check_db()
