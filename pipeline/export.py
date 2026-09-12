"""Export: one folder per person, like the People page in the reference app.

data/output/
    person_001/    <- the person in the most photos
        _cover.jpg <- their best face
        IMG_1234.jpg ...
    person_002/
    unsorted/      <- photos with faces we couldn't confidently assign
    no_faces/      <- photos where no usable face was found
    _debug/        <- every photo with its faces boxed and numbered, to check the grouping
    summary.json   <- counts from the last run (written by run.py)
"""

import shutil
from pathlib import Path

import cv2

from pipeline.config import INPUT_DIR
from pipeline.entities import Face
from pipeline.ingest import load_photo

DEBUG_MAX_SIDE = 1600  # px; debug copies are shrunk to this so they load fast

# BGR box colours for person 1, 2, 3, ... (they repeat after 9); unassigned faces are grey.
PALETTE = [(180, 119, 31), (14, 127, 255), (44, 160, 44), (40, 39, 214), (189, 103, 148),
           (75, 86, 140), (194, 119, 227), (34, 189, 188), (207, 190, 23)]
UNASSIGNED_COLOUR = (160, 160, 160)


def output_name(photo: Path) -> str:
    """data/input/trip/IMG_1.jpg -> trip__IMG_1.jpg, so same-named photos never overwrite each other."""
    return "__".join(photo.relative_to(INPUT_DIR).parts)


def copy_photo(photo: Path, folder: Path) -> None:
    """Copy (not symlink: container symlinks don't open on the Mac), keeping the file dates."""
    shutil.copy2(photo, folder / output_name(photo))


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
    """Write the person, unsorted and no_faces folders, replacing any previous run's output.

    Expects person ids already ranked by cluster.rank_people (1 = in the most photos).
    """
    if output_dir.exists():
        shutil.rmtree(output_dir)
    output_dir.mkdir(parents=True)

    photos_by_person = group_photos_by_person(faces)
    for person_id in sorted(photos_by_person):
        folder = output_dir / f"person_{person_id:03d}"
        folder.mkdir()
        for photo in photos_by_person[person_id]:
            copy_photo(photo, folder)
        cover = pick_cover_face([f for f in faces if f.person_id == person_id])
        cv2.imwrite(str(folder / "_cover.jpg"), cover.aligned)

    placed = set().union(*photos_by_person.values())
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


def export_debug_photos(photos: list[Path], faces: list[Face], folder: Path) -> None:
    """Save every photo with its faces boxed.

    Colour and "P3" = person 3, grey "?" = not in any person folder, thin box + "weak" =
    too small, blurry or turned to build groups (it could only join one).
    """
    folder.mkdir(parents=True, exist_ok=True)
    faces_by_photo: dict[Path, list[Face]] = {}
    for face in faces:
        faces_by_photo.setdefault(face.photo_path, []).append(face)

    for photo in photos:
        try:
            image = load_photo(photo)
        except Exception:
            continue  # run.py already reported unreadable photos
        scale = min(1.0, DEBUG_MAX_SIDE / max(image.shape[:2]))
        if scale < 1.0:
            image = cv2.resize(image, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
        line = max(2, round(max(image.shape[:2]) / 400))
        font_scale = max(0.5, max(image.shape[:2]) / 1600)

        for face in faces_by_photo.get(photo, []):
            x1, y1, x2, y2 = (face.bbox * scale).astype(int)
            assigned = face.person_id is not None
            colour = PALETTE[(face.person_id - 1) % len(PALETTE)] if assigned else UNASSIGNED_COLOUR
            cv2.rectangle(image, (x1, y1), (x2, y2), colour, line if face.is_strong else max(1, line // 2))

            label = (f"P{face.person_id}" if assigned else "?") + ("" if face.is_strong else " weak")
            (tw, th), baseline = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, font_scale, line // 2 + 1)
            ty = y1 - baseline - 2 if y1 - th - baseline - 6 > 0 else y1 + th + 4  # above the box if it fits
            cv2.rectangle(image, (x1, ty - th - 4), (x1 + tw + 6, ty + baseline), colour, -1)
            cv2.putText(image, label, (x1 + 3, ty), cv2.FONT_HERSHEY_SIMPLEX, font_scale,
                        (255, 255, 255), line // 2 + 1, cv2.LINE_AA)

        # Always end in lower-case .jpg (IMG_1.JPG -> IMG_1.JPG.jpg, a.jpeg -> a.jpeg.jpg); names stay unique.
        name = output_name(photo)
        if not name.endswith(".jpg"):
            name += ".jpg"
        cv2.imwrite(str(folder / name), image, [cv2.IMWRITE_JPEG_QUALITY, 85])
