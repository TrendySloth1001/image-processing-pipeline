"""Ingest: find the photos and load each one the right way up."""

from pathlib import Path

import numpy as np
from PIL import Image, ImageOps
from pillow_heif import register_heif_opener

from pipeline.config import IMAGE_EXTENSIONS

register_heif_opener()  # lets PIL open iPhone .heic photos


def list_photos(input_dir: Path) -> list[Path]:
    return sorted(
        p for p in input_dir.rglob("*")
        if p.is_file() and p.suffix.lower() in IMAGE_EXTENSIONS
    )


def load_photo(path: Path) -> np.ndarray:
    img = Image.open(path)
    img = ImageOps.exif_transpose(img)  # turn sideways phone photos upright (EXIF flag)
    img = img.convert("RGB")  # discard alpha channel if present
    arr = np.asarray(img)[:,:,::-1]  # RGB -> BGR
    return np.ascontiguousarray(arr)  # contiguous, writable, C order


