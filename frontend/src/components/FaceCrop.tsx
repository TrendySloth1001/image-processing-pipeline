import { facePicture, type FacePicture } from "@/lib/photoUrl";

/**
 * Shows one face cut out of its picture, without making crops on the server: the picture is
 * scaled and shifted inside a square box so the face fills it.
 *
 * The picture is the photo the face came from, or — for a face out of a video — the still the
 * pipeline cut for it. `facePicture` decides which, and the box is always in that picture's
 * own pixels.
 *
 * `size` gives a fixed square, for an avatar. `fill` instead takes the width of whatever it is
 * put in and stays square, for a tile in a grid; the arithmetic is the same either way, in
 * percentages rather than pixels.
 */
export function FaceCrop({
  face,
  size = 96,
  fill = false,
  zoom = 1.6,
  className = "",
}: {
  face: FacePicture;
  size?: number;
  fill?: boolean;
  zoom?: number; // how much room to leave around the face: 1 is the box itself
  className?: string;
}) {
  const picture = facePicture(face);
  const box = fill ? { width: "100%" } : { width: size, height: size };

  if (!picture.width || !picture.height) {
    return (
      <div style={box} className={`overflow-hidden ${fill ? "aspect-square" : ""} ${className}`}>
        <img src={picture.src} alt="" className="h-full w-full object-cover" />
      </div>
    );
  }

  const [x1, y1, x2, y2] = face.bbox;
  const padded = Math.max(x2 - x1, y2 - y1) * zoom;
  const left = (x1 + x2) / 2 - padded / 2;
  const top = (y1 + y2) / 2 - padded / 2;
  const scale = (value: number) => (value / padded) * (fill ? 100 : size);
  const unit = (value: number) => (fill ? `${value}%` : `${value}px`);

  return (
    <div
      style={box}
      className={`relative overflow-hidden ${fill ? "aspect-square" : ""} ${className}`}
    >
      <img
        src={picture.src}
        alt=""
        className="absolute max-w-none"
        style={{
          width: unit(scale(picture.width)),
          left: unit(scale(-left)),
          top: unit(scale(-top)),
        }}
      />
    </div>
  );
}
