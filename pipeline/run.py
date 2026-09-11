"""Run the whole pipeline: docker compose run --rm app python -m pipeline.run

Photos in data/input -> one folder per person in data/output.
"""

from pipeline import cluster, db, detect, embed, export, ingest, quality
from pipeline.config import INPUT_DIR, OUTPUT_DIR


def main() -> None:
    # 1. photos = ingest.list_photos(INPUT_DIR); print how many were found.
    # 2. Load both models once, before the loop:
    #    detector = detect.load_detector(); embedder = embed.load_embedder()
    # 3. conn = db.connect(); db.create_schema(conn); db.reset(conn)
    # 4. all_faces = []. For each photo (print progress every ~20 photos):
    #    a. image = ingest.load_photo(path). If it raises, print a warning and skip the photo.
    #    b. faces = detect.detect_faces(detector, image, path)
    #    c. Keep only faces where quality.is_usable(face) is True.
    #    d. For each face: embed.align_face(image, face), then quality.score_face(face).
    #    e. embed.embed_faces(embedder, faces)
    #    f. db.save_photo_faces(conn, path, faces)
    #    g. all_faces.extend(faces)
    #    Don't keep `image` after each loop turn; full photos are big.
    # 5. cluster.cluster_strong_faces(all_faces)
    #    cluster.attach_weak_faces(all_faces)
    #    (later) cluster.split_same_photo_conflicts(all_faces)
    # 6. db.save_person_ids(conn, all_faces)
    # 7. export.export_people(photos, all_faces, OUTPUT_DIR)
    # 8. Print a summary: photos, faces, strong faces, people, unassigned faces.


    
    raise NotImplementedError


if __name__ == "__main__":
    main()
