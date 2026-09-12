"""Detect: find every face in a photo with SCRFD."""

from pathlib import Path

import numpy as np
import onnxruntime as ort
from insightface.model_zoo.scrfd import SCRFD

from pipeline.config import DET_INPUT_SIZE, DET_THRESHOLD, DETECTOR_MODEL
from pipeline.entities import Face


def load_detector() -> SCRFD:
    # insightface's get_model() wraps every detection file in its RetinaFace class, so build
    # the SCRFD class directly: SCRFD's own code runs the SCRFD-10GF model (det_10g.onnx).
    session = ort.InferenceSession(str(DETECTOR_MODEL), providers=["CPUExecutionProvider"])
    detector = SCRFD(model_file=str(DETECTOR_MODEL), session=session)
    detector.prepare(ctx_id=-1, det_thresh=DET_THRESHOLD, input_size=DET_INPUT_SIZE)
    return detector


def detect_faces(detector: SCRFD, image: np.ndarray, photo_path: Path) -> list[Face]:
    bboxes , kpss = detector.detect(image)
    return [
        Face(
            photo_path = photo_path,
            bbox = bboxes[i, :4],
            det_score = float(bboxes[i, 4]),
            landmarks = kpss[i],
        )
        for i in range(len(bboxes))
    ] 