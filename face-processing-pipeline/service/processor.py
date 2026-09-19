"""Turn image bytes into face records. Nothing is written to disk or to a database."""

import time
from pathlib import Path

from pipeline import detect, embed, ingest, quality, video
from pipeline.config import DETECTOR_MODEL, EMBEDDER_MODEL

_models = {}


def models():
    """SCRFD and ArcFace, loaded once per worker process and reused for every job."""
    if not _models:
        _models["detector"] = detect.load_detector()
        _models["embedder"] = embed.load_embedder()
    return _models["detector"], _models["embedder"]


def process(data: bytes, store=None) -> dict:
    """`store(name, jpeg) -> key` files a preview, if the caller wants one.

    A phone photo is often HEIC, which every browser refuses to draw and every decoder here
    reads happily — so the app was serving bytes the page could not display and showing a broken
    image for a picture the pipeline had already found faces in. The preview is the same decoded
    image the faces were found in, as a JPEG, which means a consumer never has to decode anything
    exotic and the boxes line up with it by construction. It is also a tenth of the size.
    """
    detector, embedder = models()
    started = time.time()

    image = ingest.load_image_bytes(data)
    found = detect.detect_faces(detector, image, Path("-"))  # no file involved, only bytes
    faces = [f for f in found if quality.is_usable(f)]
    for face in faces:
        embed.align_face(image, face)
        quality.score_face(face)
    embed.embed_faces(embedder, faces)

    height, width = image.shape[:2]
    preview = None
    if store is not None:
        preview = {"key": store("preview", video.encode_jpeg(image)), "width": width, "height": height}
    return {
        "image": {"width": width, "height": height},
        "preview": preview,
        "detector": f"{type(detector).__name__} ({DETECTOR_MODEL.name})",
        "embedding_model": f"ArcFace ({EMBEDDER_MODEL.name})",
        "detected": len(found),  # before the minimum-size filter
        "faces": [
            {
                "bbox": [round(float(v), 2) for v in face.bbox],
                "landmarks": [[round(float(x), 2), round(float(y), 2)] for x, y in face.landmarks],
                "det_score": round(float(face.det_score), 4),
                "quality": round(float(face.quality), 4),
                "is_strong": bool(face.is_strong),
                "yaw": round(float(face.yaw), 3),  # 0 = facing the camera
        "blur": round(float(face.blur), 1),  # higher = sharper
                "embedding": [round(float(v), 6) for v in face.embedding],
            }
            for face in faces
        ],
        "took_ms": int((time.time() - started) * 1000),
    }
