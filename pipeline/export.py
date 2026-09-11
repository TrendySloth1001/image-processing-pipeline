"""Export: one folder per person, like the People page in the reference app.

data/output/
    person_001/    <- the person in the most photos
        _cover.jpg <- their best face
        IMG_1234.jpg ...
    person_002/
    unsorted/      <- photos with faces we couldn't confidently assign
    no_faces/      <- photos where no usable face was found
"""

import shutil
from pathlib import Path

import cv2

from pipeline.config import MIN_PHOTOS_PER_PERSON
from pipeline.entities import Face


def group_photos_by_person(faces: list[Face]) -> dict[int, set[Path]]:
    """person_id -> set of photo paths. A group photo appears under every person in it."""
    # 1. For each face with a person_id, add face.photo_path to that person's set.
    raise NotImplementedError


def pick_cover_face(faces_of_person: list[Face]) -> Face:
    """The face with the highest quality; it becomes the person's cover image."""
    # 1. Return max(faces_of_person, key=lambda f: f.quality).
    raise NotImplementedError


def export_people(photos: list[Path], faces: list[Face], output_dir: Path) -> None:
    """Write the folders shown at the top of this file."""
    # 1. Delete output_dir if it exists (shutil.rmtree) and recreate it (mkdir parents=True),
    #    so photos from an old run don't mix in.
    # 2. photos_by_person = group_photos_by_person(faces)
    # 3. Sort people by number of photos, biggest first (like the People row in the app).
    # 4. For each person with at least MIN_PHOTOS_PER_PERSON photos, numbered from 1:
    #    - create output_dir / f"person_{n:03d}"  (zero-padded so folders sort correctly)
    #    - copy each of their photos in with shutil.copy2 (keeps the file dates). Copy rather
    #      than symlink: symlinks made inside the container don't open on the Mac.
    #    - save pick_cover_face(...).aligned as _cover.jpg with cv2.imwrite.
    #      112 x 112 is small, but enough to check the grouping.
    # 5. unsorted/: photos that have usable faces but aren't in any person folder from step 4
    #    (all their faces are unassigned, or their person was below the minimum).
    # 6. no_faces/: photos with no usable face at all, so nothing silently disappears.
    #    Watch out for photos with the same file name in different input subfolders.
    raise NotImplementedError
