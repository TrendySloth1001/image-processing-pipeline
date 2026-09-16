"""Detect: find every face in a photo with SCRFD."""

from pathlib import Path

import numpy as np
from insightface.model_zoo.scrfd import SCRFD

from pipeline.config import (DET_INPUT_SIZE, DET_THRESHOLD, DETECT_TILES, DETECTOR_MODEL,
                             NMS_IOU, TILE_MIN_PIXELS, TILE_OVERLAP)
from pipeline.entities import Face
from pipeline.onnx import session as onnx_session


def load_detector() -> SCRFD:
    # insightface's get_model() wraps every detection file in its RetinaFace class, so build
    # the SCRFD class directly: SCRFD's own code runs the SCRFD-10GF model (det_10g.onnx).
    detector = SCRFD(model_file=str(DETECTOR_MODEL), session=onnx_session(str(DETECTOR_MODEL)))
    detector.prepare(ctx_id=-1, det_thresh=DET_THRESHOLD, input_size=DET_INPUT_SIZE)
    return detector


def _keep_best(boxes: np.ndarray, landmarks: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Non-max suppression: the same face seen in two tiles becomes one detection."""
    if len(boxes) == 0:
        return boxes, landmarks
    x1, y1, x2, y2, scores = boxes[:, 0], boxes[:, 1], boxes[:, 2], boxes[:, 3], boxes[:, 4]
    areas = (x2 - x1 + 1) * (y2 - y1 + 1)
    order = scores.argsort()[::-1]
    keep = []
    while order.size:
        best = order[0]
        keep.append(int(best))
        overlap_x1 = np.maximum(x1[best], x1[order[1:]])
        overlap_y1 = np.maximum(y1[best], y1[order[1:]])
        overlap_x2 = np.minimum(x2[best], x2[order[1:]])
        overlap_y2 = np.minimum(y2[best], y2[order[1:]])
        overlap = (np.maximum(0.0, overlap_x2 - overlap_x1 + 1)
                   * np.maximum(0.0, overlap_y2 - overlap_y1 + 1))
        iou = overlap / (areas[best] + areas[order[1:]] - overlap)
        order = order[1:][iou <= NMS_IOU]
    return boxes[keep], landmarks[keep]


def _detect_all(detector: SCRFD, image: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """One pass over the whole photo, plus tiles when DETECT_TILES asks for them."""
    boxes, landmarks = detector.detect(image)
    height, width = image.shape[:2]
    if DETECT_TILES <= 1 or height * width < TILE_MIN_PIXELS:
        return boxes, landmarks

    found_boxes = [boxes]
    found_landmarks = [landmarks]
    step_y, step_x = height / DETECT_TILES, width / DETECT_TILES
    for row in range(DETECT_TILES):
        for col in range(DETECT_TILES):
            y0 = max(0, int(row * step_y - step_y * TILE_OVERLAP))
            y1 = min(height, int((row + 1) * step_y + step_y * TILE_OVERLAP))
            x0 = max(0, int(col * step_x - step_x * TILE_OVERLAP))
            x1 = min(width, int((col + 1) * step_x + step_x * TILE_OVERLAP))
            tile_boxes, tile_landmarks = detector.detect(image[y0:y1, x0:x1])
            if not len(tile_boxes):
                continue
            tile_boxes[:, [0, 2]] += x0  # back into whole-photo coordinates
            tile_boxes[:, [1, 3]] += y0
            tile_landmarks[:, :, 0] += x0
            tile_landmarks[:, :, 1] += y0
            found_boxes.append(tile_boxes)
            found_landmarks.append(tile_landmarks)

    return _keep_best(np.vstack(found_boxes), np.vstack(found_landmarks))


def detect_faces(detector: SCRFD, image: np.ndarray, photo_path: Path) -> list[Face]:
    bboxes, kpss = _detect_all(detector, image)
    return [
        Face(
            photo_path=photo_path,
            bbox=bboxes[i, :4],
            det_score=float(bboxes[i, 4]),
            landmarks=kpss[i],
        )
        for i in range(len(bboxes))
    ]
