import { facePicture, type FacePicture } from "@/lib/photoUrl";

/**
 * Shows one face cut out of its picture, without making crops on the server: the picture is
 * scaled and shifted inside a square box so the face fills it.
 *
 * The picture is the photo the face came from, or — for a face out of a video — the still the
 * pipeline cut for it. `facePicture` decides which, and the box is always in that picture's
 * own pixels.
 */
export function FaceCrop({
  face,
  size = 96,
  className = "",
}: {
  face: FacePicture;
  size?: number;
  className?: string;
}) {
  const picture = facePicture(face);
  if (!picture.width || !picture.height) {
    return <img src={picture.src} alt="" style={{ width: size, height: size }} className={`object-cover ${className}`} />;
  }

  const [x1, y1, x2, y2] = face.bbox;
  const padded = Math.max(x2 - x1, y2 - y1) * 1.6; // a little room around the face
  const left = (x1 + x2) / 2 - padded / 2;
  const top = (y1 + y2) / 2 - padded / 2;

  return (
    <div style={{ width: size, height: size }} className={`relative overflow-hidden ${className}`}>
      <img
        src={picture.src}
        alt=""
        className="absolute max-w-none"
        style={{
          width: (picture.width / padded) * size,
          left: (-left / padded) * size,
          top: (-top / padded) * size,
        }}
      />
    </div>
  );
}
