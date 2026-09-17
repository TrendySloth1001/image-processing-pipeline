"""All paths and tunable numbers in one place.

The numbers are starting points. Tune them on your own photos once the pipeline runs end to end.
"""

import os
from pathlib import Path

# --- Paths (inside the container; the project folder is mounted at /app) ---
INPUT_DIR = Path("data/input")    # put photos here
OUTPUT_DIR = Path("data/output")  # one folder per person is written here
MODELS_DIR = Path(os.environ["MODELS_DIR"]) / "models" / "buffalo_l"
# int8 copies are built into the image: same faces, same grouping, a fraction of the CPU.
# Set MODEL_PRECISION=fp32 to fall back to the original weights.
_PRECISION = "" if os.environ.get("MODEL_PRECISION", "int8") == "fp32" else "_int8"
DETECTOR_MODEL = MODELS_DIR / f"det_10g{_PRECISION}.onnx"    # SCRFD-10GF: boxes + 5 landmarks
EMBEDDER_MODEL = MODELS_DIR / f"w600k_r50{_PRECISION}.onnx"  # ArcFace R50: 512-number face vector
DATABASE_URL = os.environ["DATABASE_URL"]

# --- Ingest ---
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif"}
# Photos are decoded no larger than this. The detector works at 640px, so a 12-megapixel phone
# photo carries no extra information for it, only cost. None keeps the original size.
MAX_DECODE_SIDE = int(os.environ.get("MAX_DECODE_SIDE", "2048"))

# --- CPU ---
# Threads per ONNX session. Past 4 the gain is small, so run more workers instead:
# docker compose up -d --scale worker=2
ORT_THREADS = int(os.environ.get("ORT_THREADS", "4"))

# --- Detection (SCRFD) ---
DET_INPUT_SIZE = (640, 640)  # each photo is resized to fit this before detection
DET_THRESHOLD = 0.5          # detections with a lower confidence are dropped
# Small faces in a wide group shot arrive at the detector only ~20px across. Running it again
# over overlapping tiles shows those faces much larger, and the results are merged.
# Enlarging DET_INPUT_SIZE instead does not work: big selfie faces then overflow the model's
# largest anchor and get lost. 1 = single pass over the whole photo, 2 = also 2x2 tiles.
DETECT_TILES = int(os.environ.get("DETECT_TILES", "2"))
TILE_OVERLAP = 0.25  # fraction of a tile shared with its neighbour, so faces on a seam survive
# Tiling costs about a quarter more CPU and only pays on big frames holding small faces, so
# small photos take the single pass. A selfie gains nothing from being cut into four.
TILE_MIN_PIXELS = float(os.environ.get("TILE_MIN_PIXELS", "2e6"))
NMS_IOU = 0.4        # two boxes overlapping more than this are the same face

# --- Video ---
VIDEO_EXTENSIONS = {".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi"}
# Frames a second handed to the detector. A face does not change meaningfully in 33ms, so 30fps
# is thirty times the work of 2fps for the same people. Raise it only if people flash past.
VIDEO_FPS = float(os.environ.get("VIDEO_FPS", "2"))
# Frames are decoded no larger than this. Lower than a photo's 2048 on purpose: faces fill more
# of a video frame, and staying under TILE_MIN_PIXELS keeps detection to one pass per frame.
VIDEO_MAX_SIDE = int(os.environ.get("VIDEO_MAX_SIDE", "1280"))
VIDEO_MAX_SECONDS = float(os.environ.get("VIDEO_MAX_SECONDS", "0"))  # 0 = the whole video
VIDEO_READ_CHUNK = int(os.environ.get("VIDEO_READ_CHUNK", str(4 * 1024 * 1024)))  # bytes per range request

# --- Tracking (one person's continuous appearance in a video) ---
TRACK_FACES = int(os.environ.get("TRACK_FACES", "3"))  # representative faces delivered per track
TRACK_SAME_FACE = 0.5      # embedding agreement that alone says "same appearance"
TRACK_NEAR_FACE = 0.3      # weaker agreement, accepted only when the box barely moved
TRACK_IOU = 0.3            # how much the box must overlap for that rescue to apply
TRACK_MAX_GAP_MS = 2000    # away longer than this and the next sighting is a new appearance
TRACK_REDUNDANT = 0.92     # a face this close to one already kept adds nothing new
MIN_TRACK_FRAMES = 2       # seen in one frame only: a flicker, not a person
# Each representative face is filed with the whole frame it was seen in, at the size the frame
# was decoded, so the consumer can show what was happening and not only the face. Frames are
# shared between everyone visible at that moment, which is what makes keeping them whole cheap.
STILL_QUALITY = 82
POSTER_MAX_SIDE = 1280     # the video's own thumbnail, cut from its first sampled frame

# --- Quality ---
MIN_FACE_SIZE = 40       # px, shorter side of the face box; smaller faces are ignored entirely
STRONG_FACE_SIZE = 80    # px; a face must be at least this big to help build groups
MIN_BLUR_SCORE = 50.0    # sharpness of the aligned crop; below this it's too blurry to build groups
MAX_YAW_RATIO = 0.5      # how far the head may be turned (0 = looking straight at the camera)

# A face in a video frame is nothing like a face in a 12-megapixel photo. Measured over a 720p
# clip: someone a few metres from the camera is 34-49px with a blur score of 7-45, where the same
# people in photos are 102-874px and 198-6929. The blur score is partly a measure of resolution —
# a 40px face stretched to the 112px crop simply has no fine detail to find — so judging a video
# by the photo numbers threw away every face in it, including ones that went on to match their
# person at 0.69-0.77. Video gets its own floors.
VIDEO_MIN_FACE_SIZE = int(os.environ.get("VIDEO_MIN_FACE_SIZE", "24"))
VIDEO_STRONG_FACE_SIZE = int(os.environ.get("VIDEO_STRONG_FACE_SIZE", "40"))
VIDEO_MIN_BLUR_SCORE = float(os.environ.get("VIDEO_MIN_BLUR_SCORE", "6"))

# --- Clustering (cosine distance = 1 - similarity; 0 = identical, 1 = unrelated) ---
CLUSTER_DISTANCE = 0.55  # strong faces closer than this (on average) become one person
ATTACH_DISTANCE = 0.50   # a weak face joins a person only if it is this close to their average face
# People in fewer photos go to the "unsorted" folder. 1 shows everyone, which is what you want
# while testing; raise it to 2+ for a real gallery, where it hides strangers caught in the background.
MIN_PHOTOS_PER_PERSON = 1
