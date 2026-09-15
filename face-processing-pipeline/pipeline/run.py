"""Run the whole pipeline: python -m pipeline.run  (from the dev container terminal)

Photos in data/input -> one folder per person in data/output. Every step is reported through
log(), so the command line prints them and the web UI shows them as they happen.
"""

import json
import time
import warnings
from dataclasses import asdict, dataclass
from typing import Callable

from insightface.model_zoo.arcface_onnx import ArcFaceONNX
from insightface.model_zoo.scrfd import SCRFD

from pipeline import cluster, db, detect, embed, export, ingest, quality
from pipeline.config import (ATTACH_DISTANCE, CLUSTER_DISTANCE, DETECTOR_MODEL, EMBEDDER_MODEL,
                             INPUT_DIR, MIN_PHOTOS_PER_PERSON, OUTPUT_DIR)

# insightface calls a scikit-image function that is deprecated; harmless, so hide it.
warnings.filterwarnings("ignore", category=FutureWarning, module="insightface")


@dataclass
class RunSummary:
    photos: int
    faces: int
    strong: int
    people: int
    unassigned: int
    skipped: int      # photos that couldn't be opened
    seconds: float
    finished_at: float
    detector: str     # which face detector ran, e.g. "SCRFD (det_10g.onnx)"


def run_pipeline(detector: SCRFD | None = None, embedder: ArcFaceONNX | None = None,
                 log: Callable[[str], None] = print) -> RunSummary:
    """Group every photo in data/input by person. Lines starting with two spaces are details."""
    started = time.time()
    photos = ingest.list_photos(INPUT_DIR)
    log(f"Found {len(photos)} photos in {INPUT_DIR}")

    if detector is None:
        t = time.time()
        detector = detect.load_detector()
        log(f"Loaded SCRFD detector {DETECTOR_MODEL.name} ({time.time() - t:.1f}s)")
    else:
        log(f"SCRFD detector {DETECTOR_MODEL.name} already in memory")
    if embedder is None:
        t = time.time()
        embedder = embed.load_embedder()
        log(f"Loaded ArcFace embedder {EMBEDDER_MODEL.name} ({time.time() - t:.1f}s)")
    else:
        log(f"ArcFace embedder {EMBEDDER_MODEL.name} already in memory")

    all_faces = []
    skipped = 0
    with db.connect() as conn:
        db.create_schema(conn)
        db.reset(conn)
        log("PostgreSQL ready, previous run cleared")
        log(f"Detecting, aligning and embedding faces in {len(photos)} photos")
        for i, path in enumerate(photos, start=1):
            t = time.time()
            try:
                image = ingest.load_photo(path)
            except Exception as e:  # corrupt or unsupported file: skip it, keep going
                log(f"  {i}/{len(photos)} {path.name}: skipped, cannot open ({e})")
                skipped += 1
                continue
            found = detect.detect_faces(detector, image, path)
            faces = [f for f in found if quality.is_usable(f)]
            for face in faces:
                embed.align_face(image, face)
                quality.score_face(face)
            embed.embed_faces(embedder, faces)
            db.save_photo_faces(conn, path, faces)
            all_faces.extend(faces)
            height, width = image.shape[:2]
            log(f"  {i}/{len(photos)} {path.name}: {width}x{height}, SCRFD found {len(found)} face(s), "
                f"{len(faces)} big enough, {sum(f.is_strong for f in faces)} strong ({time.time() - t:.1f}s)")

        strong = sum(f.is_strong for f in all_faces)
        log(f"Clustering {strong} strong faces (one person if similarity > {1 - CLUSTER_DISTANCE:.2f})")
        cluster.cluster_strong_faces(all_faces)
        log(f"  {len({f.person_id for f in all_faces if f.person_id is not None})} groups")

        weak = len(all_faces) - strong
        log(f"Attaching {weak} weak faces to the closest group (needs similarity > {1 - ATTACH_DISTANCE:.2f})")
        cluster.attach_weak_faces(all_faces)
        log(f"  {sum(1 for f in all_faces if not f.is_strong and f.person_id is not None)} of them joined a group")

        assigned = sum(f.person_id is not None for f in all_faces)
        cluster.split_same_photo_conflicts(all_faces)
        log("Two faces in one photo can't be the same person")
        log(f"  {assigned - sum(f.person_id is not None for f in all_faces)} face(s) unassigned by that rule")

        cluster.rank_people(all_faces)
        people = len({f.person_id for f in all_faces if f.person_id is not None})
        unassigned = sum(f.person_id is None for f in all_faces)
        log(f"Numbering people by photo count (a person needs {MIN_PHOTOS_PER_PERSON}+ photo(s))")
        log(f"  {people} people, {unassigned} faces left unassigned")

        db.save_person_ids(conn, all_faces)
        log("Saved the grouping to PostgreSQL")

    export.export_people(photos, all_faces, OUTPUT_DIR)
    log(f"Wrote {people} person folders with cover faces to {OUTPUT_DIR}")
    export.export_debug_photos(photos, all_faces, OUTPUT_DIR / "_debug")
    log(f"Wrote {len(photos) - skipped} photos with face boxes to {OUTPUT_DIR}/_debug")

    summary = RunSummary(
        photos=len(photos),
        faces=len(all_faces),
        strong=strong,
        people=people,
        unassigned=unassigned,
        skipped=skipped,
        seconds=round(time.time() - started, 1),
        finished_at=time.time(),
        detector=f"{type(detector).__name__} ({DETECTOR_MODEL.name})",
    )
    (OUTPUT_DIR / "summary.json").write_text(json.dumps(asdict(summary), indent=2))
    log(f"Done in {summary.seconds}s")
    return summary


def main() -> None:
    s = run_pipeline()
    print(f"{s.photos} photos, {s.faces} faces ({s.strong} strong), {s.people} people, "
          f"{s.unassigned} unassigned faces -> {OUTPUT_DIR}")


if __name__ == "__main__":
    main()
