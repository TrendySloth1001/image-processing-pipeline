"""Run the whole pipeline: python -m pipeline.run  (from the dev container terminal)

Photos in data/input -> one folder per person in data/output.
"""

import warnings

from pipeline import cluster, db, detect, embed, export, ingest, quality
from pipeline.config import INPUT_DIR, OUTPUT_DIR

# insightface calls a scikit-image function that is deprecated; harmless, so hide it.
warnings.filterwarnings("ignore", category=FutureWarning, module="insightface")


def main() -> None:
    photos = ingest.list_photos(INPUT_DIR)
    print(f"Found {len(photos)} photos in {INPUT_DIR}")

    detector = detect.load_detector()
    embedder = embed.load_embedder()

    conn = db.connect()
    db.create_schema(conn)
    db.reset(conn)

    all_faces = []
    for i, path in enumerate(photos, start=1):
        try:
            image = ingest.load_photo(path)
        except Exception as e:  # corrupt or unsupported file: skip it, keep going
            print(f"  skipping {path}: {e}")
            continue
        faces = detect.detect_faces(detector, image, path)
        faces = [f for f in faces if quality.is_usable(f)]
        for face in faces:
            embed.align_face(image, face)
            quality.score_face(face)
        embed.embed_faces(embedder, faces)
        db.save_photo_faces(conn, path, faces)
        all_faces.extend(faces)
        if i % 20 == 0 or i == len(photos):
            print(f"  {i}/{len(photos)} photos, {len(all_faces)} faces so far")

    cluster.cluster_strong_faces(all_faces)
    cluster.attach_weak_faces(all_faces)
    cluster.split_same_photo_conflicts(all_faces)
    db.save_person_ids(conn, all_faces)
    export.export_people(photos, all_faces, OUTPUT_DIR)

    strong = sum(f.is_strong for f in all_faces)
    people = len({f.person_id for f in all_faces if f.person_id is not None})
    unassigned = sum(f.person_id is None for f in all_faces)
    print(f"Done: {len(photos)} photos, {len(all_faces)} faces ({strong} strong), "
          f"{people} people, {unassigned} unassigned faces -> {OUTPUT_DIR}")


if __name__ == "__main__":
    main()
