# Face grouping prototype

Photos in `data/input/` → one folder per person in `data/output/`.
Everything runs in Docker; nothing is installed on the host.

```
list photos → load (fix rotation) → SCRFD detect → drop tiny faces → align → quality
→ ArcFace embed → save to Postgres → cluster strong faces → attach weak faces → export folders
```

## Setup

```sh
docker compose build                                    # Python 3.11 + insightface + SCRFD/ArcFace models
docker compose up -d db                                 # Postgres 17 + pgvector
docker compose run --rm app python scripts/check_env.py # should print "SCRFD found N faces" and the pgvector version
```

Open a Python shell inside the container (used for the checks below):

```sh
docker compose run --rm app python
```

After changing `requirements.txt` or the `Dockerfile`, run `docker compose build` again.
Code changes need no rebuild: the project folder is mounted into the container.

## Editor (VS Code)

Open the project with **Dev Containers: Reopen in Container** (Cmd+Shift+P). VS Code then runs
inside the app container, so imports resolve and autocomplete works without installing anything
on the Mac. Its terminal is inside the container too: run `python` or `python -m pipeline.run`
directly, without `docker compose run`.

## Build order

Every function in `pipeline/` is a stub with step-by-step comments. Replace each
`raise NotImplementedError` with code, in this order. Run each step's check before moving on.

### 1. `pipeline/config.py`
Read it. Nothing to write; these are the paths and the numbers you'll tune later.

### 2. `pipeline/ingest.py` → `list_photos`, `load_photo`
Put some phone photos in `data/input/`, then:
```python
from pipeline.config import INPUT_DIR
from pipeline.ingest import list_photos, load_photo
photos = list_photos(INPUT_DIR); len(photos)
load_photo(photos[0]).shape            # (height, width, 3)
```

### 3. `pipeline/detect.py` → `load_detector`, `detect_faces`
```python
from pipeline.detect import load_detector, detect_faces
det = load_detector()
img = load_photo(photos[0])
faces = detect_faces(det, img, photos[0])
[(f.bbox.round(), round(f.det_score, 2)) for f in faces]
```

### 4. `pipeline/embed.py` → `load_embedder`, `align_face`, `embed_faces`
```python
import cv2, numpy as np
from pipeline.embed import load_embedder, align_face, embed_faces
emb = load_embedder()
for f in faces: align_face(img, f)
cv2.imwrite("data/output/debug_face.jpg", faces[0].aligned)   # open it on the Mac: a centred face
embed_faces(emb, faces)
faces[0].embedding.shape, float(np.linalg.norm(faces[0].embedding))   # (512,), 1.0
```
Compare two faces with `float(a.embedding @ b.embedding)`. The same person usually scores
around 0.4 or more; different people usually score below 0.2.

### 5. `pipeline/quality.py` → `face_size`, `blur_score`, `yaw_ratio`, `is_usable`, `score_face`
```python
from pipeline.quality import score_face
for f in faces: score_face(f); print(round(f.quality, 2), f.is_strong)
```

### 6. `pipeline/db.py` → `connect`, `create_schema`, `reset`, `save_photo_faces`, `save_person_ids`
```python
from pipeline.db import connect, create_schema
conn = connect(); create_schema(conn)
```
Then look at the table from your terminal:
`docker compose exec db psql -U faces -d faces -c "\d faces"`

### 7. `pipeline/cluster.py` → `cluster_strong_faces`, `person_centroids`, `attach_weak_faces`
### 8. `pipeline/export.py` → `group_photos_by_person`, `pick_cover_face`, `export_people`
### 9. `pipeline/run.py` → `main`
Steps 7–9 are easiest to test together:
```sh
docker compose run --rm app python -m pipeline.run
```
Then open `data/output/` in Finder.

### 10. Tune
- One person split across several folders → raise `CLUSTER_DISTANCE` a little.
- Different people mixed in one folder → lower it.
- Good photos stuck in `unsorted/` → raise `ATTACH_DISTANCE` a little, or relax the quality numbers.
- After that works, try `cluster.split_same_photo_conflicts`.

## Notes
- Docker on a Mac can't use the GPU, so everything runs on the CPU. Expect roughly a few photos per second.
- InsightFace's pretrained SCRFD/ArcFace weights (buffalo_l) are for non-commercial research only.
