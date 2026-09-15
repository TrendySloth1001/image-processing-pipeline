import { photoUrl } from "@/lib/photoUrl";

/**
 * Shows one face cut out of its photo, without making crops on the server: the photo is
 * scaled and shifted inside a square box so the face fills it.
 */
export function FaceCrop({
  photoId,
  photoKey,
  bbox,
  width,
  height,
  size = 96,
  className = "",
}: {
  photoId: number;
  photoKey?: string | null;
  bbox: number[];
  width: number | null;
  height: number | null;
  size?: number;
  className?: string;
}) {
  const source = photoUrl(photoId, photoKey);
  if (!width || !height) {
    return <img src={source} alt="" style={{ width: size, height: size }} className={`object-cover ${className}`} />;
  }

  const [x1, y1, x2, y2] = bbox;
  const padded = Math.max(x2 - x1, y2 - y1) * 1.6; // a little room around the face
  const left = (x1 + x2) / 2 - padded / 2;
  const top = (y1 + y2) / 2 - padded / 2;

  return (
    <div style={{ width: size, height: size }} className={`relative overflow-hidden ${className}`}>
      <img
        src={source}
        alt=""
        className="absolute max-w-none"
        style={{
          width: (width / padded) * size,
          left: (-left / padded) * size,
          top: (-top / padded) * size,
        }}
      />
    </div>
  );
}
