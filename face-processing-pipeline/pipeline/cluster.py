"""Cluster: group face embeddings into people.

Two passes: strong faces build the groups, then weak faces join the closest group
only if they are clearly close. Anything unclear stays unassigned; a mixed-up group
is worse for users than a missing photo.
"""

import numpy as np
from sklearn.cluster import AgglomerativeClustering

from pipeline.config import ATTACH_DISTANCE, CLUSTER_DISTANCE, MIN_PHOTOS_PER_PERSON
from pipeline.entities import Face


def cluster_strong_faces(faces: list[Face]) -> None:
    strong = [f for f in faces if f.is_strong]
    if len(strong) < 2:
        for i, face  in enumerate(strong):
            face.person_id = i
        return
    x = np.array([f.embedding for f in strong])
    clustering = AgglomerativeClustering(n_clusters=None, distance_threshold=CLUSTER_DISTANCE,
                                         metric='cosine', linkage='average')
    clustering.fit_predict(x)
    for face, person_id in zip(strong, clustering.labels_):
        face.person_id = int(person_id)


def person_centroids(faces: list[Face]) -> dict[int, np.ndarray]:
    #Each person's average face: person_id -> embedding of length 1
    by_person: dict[int, list[np.ndarray]] = {}
    for face in faces:
        if face.person_id is not None:
            by_person.setdefault(face.person_id, []).append(face.embedding)
    centroids = {}
    for person_id, embeddings in by_person.items():
        mean = np.mean(embeddings, axis=0)
        centroids[person_id] = mean / np.linalg.norm(mean)
    return centroids


def attach_weak_faces(faces: list[Face]) -> None:
    centroids = person_centroids(faces)
    if not centroids:
        return
    person_ids = list(centroids)
    C = np.stack([centroids[pid] for pid in person_ids])
    for face in faces:
        if face.is_strong:
            continue
        distances = 1 - C @ face.embedding
        best = int(np.argmin(distances))
        if distances[best] < ATTACH_DISTANCE:
            face.person_id = person_ids[best]

def split_same_photo_conflicts(faces: list[Face]) -> None:
    centroids = person_centroids(faces)
    grouped = {}
    for face in faces:
        if face.person_id is not None:
            grouped.setdefault((face.person_id, face.photo_path), []).append(face)
    for (person_id, _), group in grouped.items():
        if len(group) < 2:
            continue
        keep = max(group, key = lambda f: f.embedding @ centroids[person_id])
        for face in group:
            if face is not keep:
                face.person_id = None


def rank_people(faces: list[Face]) -> None:
    """Renumber people 1, 2, 3, ... by how many photos they are in, most first.

    People in fewer than MIN_PHOTOS_PER_PERSON photos become unassigned, so the numbers
    match the person_NNN folders, the database and the web UI.
    """
    photos_by_person: dict[int, set] = {}
    for face in faces:
        if face.person_id is not None:
            photos_by_person.setdefault(face.person_id, set()).add(face.photo_path)
    # Ties are broken by first photo name, so the same photos always give the same numbers.
    ranked = sorted(photos_by_person, key=lambda pid: (-len(photos_by_person[pid]), min(photos_by_person[pid])))
    new_ids = {}
    for pid in ranked:
        if len(photos_by_person[pid]) >= MIN_PHOTOS_PER_PERSON:
            new_ids[pid] = len(new_ids) + 1
    for face in faces:
        if face.person_id is not None:
            face.person_id = new_ids.get(face.person_id)
