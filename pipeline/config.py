"""All paths and tunable numbers in one place.

The numbers are starting points. Tune them on your own photos once the pipeline runs end to end.
"""

import os
from pathlib import Path

# --- Paths (inside the container; the project folder is mounted at /app) ---
INPUT_DIR = Path("data/input")    # put photos here
OUTPUT_DIR = Path("data/output")  # one folder per person is written here
MODELS_DIR = Path(os.environ["MODELS_DIR"]) / "models" / "buffalo_l"
DETECTOR_MODEL = MODELS_DIR / "det_10g.onnx"    # SCRFD-10GF: boxes + 5 landmarks
EMBEDDER_MODEL = MODELS_DIR / "w600k_r50.onnx"  # ArcFace R50: 512-number face vector
DATABASE_URL = os.environ["DATABASE_URL"]

# --- Ingest ---
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif"}

# --- Detection (SCRFD) ---
DET_INPUT_SIZE = (640, 640)  # each photo is resized to fit this before detection
DET_THRESHOLD = 0.5          # detections with a lower confidence are dropped

# --- Quality ---
MIN_FACE_SIZE = 40       # px, shorter side of the face box; smaller faces are ignored entirely
STRONG_FACE_SIZE = 80    # px; a face must be at least this big to help build groups
MIN_BLUR_SCORE = 50.0    # sharpness of the aligned crop; below this it's too blurry to build groups
MAX_YAW_RATIO = 0.5      # how far the head may be turned (0 = looking straight at the camera)

# --- Clustering (cosine distance = 1 - similarity; 0 = identical, 1 = unrelated) ---
CLUSTER_DISTANCE = 0.55  # strong faces closer than this (on average) become one person
ATTACH_DISTANCE = 0.50   # a weak face joins a person only if it is this close to their average face
# People in fewer photos go to the "unsorted" folder. 1 shows everyone, which is what you want
# while testing; raise it to 2+ for a real gallery, where it hides strangers caught in the background.
MIN_PHOTOS_PER_PERSON = 1
