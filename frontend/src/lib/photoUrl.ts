/**
 * URLs for stored media, and the picture that goes with a face.
 *
 * Row ids come round again after the table is cleared, so a plain /api/photos/3 can hit a
 * browser's cached copy of a completely different photo. The object key is unique per upload,
 * so putting it in the URL makes every photo its own address.
 */
function versioned(path: string, key?: string | null) {
  const version = key ? key.split("/").pop() : null;
  return version ? `${path}?v=${encodeURIComponent(version)}` : path;
}

/** A photo, or a video's poster frame — either way, something an <img> can show. */
export function photoUrl(photoId: number, photoKey?: string | null) {
  return versioned(`/api/photos/${photoId}`, photoKey);
}

/** The video itself, for a <video> tag. */
export function videoUrl(photoId: number, photoKey?: string | null) {
  return versioned(`/api/videos/${photoId}`, photoKey);
}

export type FacePicture = {
  photo_id: number;
  key: string;
  bbox: number[];
  width: number | null;
  height: number | null;
  still_key?: string | null;
  still_width?: number | null;
  still_height?: number | null;
  face_id?: number;
  id?: number;
};

/**
 * Where to find a face's picture and what size that picture is.
 *
 * A face from a photo is shown by shifting the photo itself. A face from a video is shown from
 * the still the pipeline cut for it: its box is in the still's pixels, and the video would be
 * useless here anyway — a browser cannot crop a face out of one frame of an <img>.
 */
export function facePicture(face: FacePicture) {
  if (face.still_key) {
    return {
      src: versioned(`/api/stills/${face.face_id ?? face.id}`, face.still_key),
      width: face.still_width ?? null,
      height: face.still_height ?? null,
    };
  }
  return { src: photoUrl(face.photo_id, face.key), width: face.width, height: face.height };
}
