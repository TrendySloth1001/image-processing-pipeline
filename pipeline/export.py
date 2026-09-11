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

from pipeline.config import INPUT_DIR, MIN_PHOTOS_PER_PERSON
from pipeline.entities import Face


def copy_photo(photo: Path, folder: Path) -> None:
    """Copy (not symlink: container symlinks don't open on the Mac), keeping the file dates.

    data/input/trip/IMG_1.jpg becomes trip__IMG_1.jpg, so same-named photos never overwrite each other.
    """
    shutil.copy2(photo, folder / "__".join(photo.relative_to(INPUT_DIR).parts))


def group_photos_by_person(faces: list[Face]) -> dict[int, set[Path]]:
    """person_id -> set of photo paths. A group photo appears under every person in it."""
    photos_by_person: dict[int, set[Path]] = {}
    for face in faces:
        if face.person_id is not None:
            photos_by_person.setdefault(face.person_id, set()).add(face.photo_path)
    return photos_by_person


def pick_cover_face(faces_of_person: list[Face]) -> Face:
    """The face with the highest quality; it becomes the person's cover image."""
    return max(faces_of_person, key=lambda f: f.quality)


def export_people(photos: list[Path], faces: list[Face], output_dir: Path) -> None:
    """Write the folders shown at the top of this file, replacing any previous run's output."""
    if output_dir.exists():
        shutil.rmtree(output_dir)
    output_dir.mkdir(parents=True)

    photos_by_person = group_photos_by_person(faces)
    people = sorted(photos_by_person.items(), key=lambda item: len(item[1]), reverse=True)

    placed: set[Path] = set()
    number = 0
    for person_id, person_photos in people:
        if len(person_photos) < MIN_PHOTOS_PER_PERSON:
            continue
        number += 1
        folder = output_dir / f"person_{number:03d}"
        folder.mkdir()
        for photo in person_photos:
            copy_photo(photo, folder)
        cover = pick_cover_face([f for f in faces if f.person_id == person_id])
        cv2.imwrite(str(folder / "_cover.jpg"), cover.aligned)
        placed |= person_photos

    photos_with_faces = {f.photo_path for f in faces}
    leftovers = {
        "unsorted": photos_with_faces - placed,
        "no_faces": set(photos) - photos_with_faces,
    }
    for name, leftover in leftovers.items():
        if leftover:
            folder = output_dir / name
            folder.mkdir()
            for photo in leftover:
                copy_photo(photo, folder)
