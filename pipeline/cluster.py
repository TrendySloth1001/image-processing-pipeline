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
    """Group the strong faces into people by setting face.person_id to 0, 1, 2, ..."""
    # 1. strong = the faces with is_strong True.
    # 2. If there are fewer than 2, give each one its own person_id and return
    #    (the clustering below needs at least 2 faces).
    # 3. X = np.stack([f.embedding for f in strong])  -> N x 512.
    # 4. labels = AgglomerativeClustering(n_clusters=None, metric="cosine", linkage="average",
    #                                     distance_threshold=CLUSTER_DISTANCE).fit_predict(X)
    #    "average" linkage merges two groups only if their faces are close ON AVERAGE,
    #    so one odd photo can't glue two people together.
    # 5. Set strong[i].person_id = int(labels[i]).
    raise NotImplementedError


def person_centroids(faces: list[Face]) -> dict[int, np.ndarray]:
    """Each person's average face: person_id -> embedding of length 1."""
    # 1. Group the embeddings of faces with a person_id (skip None).
    # 2. For each person: take the mean of their embeddings, then divide by its norm.
    raise NotImplementedError


def attach_weak_faces(faces: list[Face]) -> None:
    """Give each weak face the nearest person, but only if it is close enough."""
    # 1. centroids = person_centroids(faces). Right after cluster_strong_faces, only
    #    strong faces have a person_id, so centroids come from strong faces only.
    # 2. If there are no centroids, return.
    # 3. For each face with is_strong False:
    #    - distance to a person = 1 - (face.embedding @ centroid)
    #    - find the closest person
    #    - if that distance < ATTACH_DISTANCE: face.person_id = that person
    #    - otherwise leave person_id as None (it goes to "unsorted")
    raise NotImplementedError


def split_same_photo_conflicts(faces: list[Face]) -> None:
    """Optional, do it after everything else works.

    Two faces in the same photo are almost never the same person. If a person
    ended up with two faces from one photo, keep the one closer to that person's
    average face and set the other's person_id to None.
    """
    # 1. centroids = person_centroids(faces)
    # 2. Group faces by (person_id, photo_path), skipping person_id None.
    # 3. In any group with 2+ faces, keep the face with the highest (embedding @ centroid);
    #    set person_id = None on the rest.
    raise NotImplementedError
