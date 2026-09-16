"""Ingest: find the photos and load each one the right way up."""

import io
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageOps
from pillow_heif import register_heif_opener

from pipeline.config import IMAGE_EXTENSIONS, MAX_DECODE_SIDE

register_heif_opener()  # lets PIL open iPhone .heic photos


def list_photos(input_dir: Path) -> list[Path]:
    return sorted(
        p for p in input_dir.rglob("*")
        if p.is_file() and p.suffix.lower() in IMAGE_EXTENSIONS
    )


def _draft(img: Image.Image, max_side: int) -> None:
    """Ask libjpeg to decode at 1/2, 1/4 or 1/8 scale.

    draft() reduces by min(width // asked_width, height // asked_height), so it must be asked
    for a box with the photo's own shape. A square box would give min(2, 1) = 1 on a 4:3 photo
    and decode nothing smaller.
    """
    width, height = img.size
    if max(width, height) <= max_side:
        return
    ratio = max_side / max(width, height)
    img.draft("RGB", (max(1, round(width * ratio)), max(1, round(height * ratio))))


def _to_bgr(img: Image.Image, max_side: int | None) -> np.ndarray:
    img = ImageOps.exif_transpose(img)  # turn sideways phone photos upright (EXIF flag)
    img = img.convert("RGB")  # discard alpha channel if present
    arr = np.ascontiguousarray(np.asarray(img)[:, :, ::-1])  # RGB -> BGR, contiguous for OpenCV
    if max_side:
        height, width = arr.shape[:2]
        if max(height, width) > max_side:
            scale = max_side / max(height, width)
            arr = cv2.resize(arr, (round(width * scale), round(height * scale)),
                             interpolation=cv2.INTER_AREA)
    return arr


def load_photo(path: Path, max_side: int | None = MAX_DECODE_SIDE) -> np.ndarray:
    img = Image.open(path)
    if max_side:
        _draft(img, max_side)
    return _to_bgr(img, max_side)


def load_image_bytes(data: bytes, max_side: int | None = MAX_DECODE_SIDE) -> np.ndarray:
    """Same, for a photo held in memory: the microservice never touches the disk.

    draft() lets libjpeg decode at 1/2, 1/4 or 1/8 scale. A 12-megapixel phone photo becomes
    3 megapixels before it ever reaches memory, which also makes the detector's own resize
    much cheaper. Faces are unaffected: the detector works at 640px either way.
    """
    img = Image.open(io.BytesIO(data))
    if max_side:
        _draft(img, max_side)
    return _to_bgr(img, max_side)
