"""Cluster: group face embeddings into people.

Two passes: strong faces build the groups, then weak faces join the closest group
only if they are clearly close. Anything unclear stays unassigned; a mixed-up group
is worse for users than a missing photo.
"""

import numpy as np
from sklearn.cluster import AgglomerativeClustering

from pipeline.config import ATTACH_DISTANCE, CLUSTER_DISTANCE
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
