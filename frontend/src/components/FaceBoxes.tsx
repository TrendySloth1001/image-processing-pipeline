/** Box colour per person, so the same person keeps the same colour across photos. */
const PALETTE = ["#2563eb", "#ea580c", "#16a34a", "#dc2626", "#7c3aed", "#0891b2", "#db2777", "#65a30d", "#a16207"];
export const personColour = (personId: number | null) =>
  personId ? PALETTE[(personId - 1) % PALETTE.length] : "#9ca3af";

export type BoxFace = {
  face_id: number;
  person_id: number | null;
  bbox: number[];
  quality: number;
  is_strong: boolean;
};

/**
 * A picture with a box around every face the pipeline found in it. Boxes are placed in
 * percentages of the picture's own pixel size, so they line up at any display width.
 *
 * The picture is a photo, or — for faces out of a video — one of the stills the pipeline cut,
 * which is why the source is passed in rather than worked out from a photo id.
 */
export function FaceBoxes({
  src,
  width,
  height,
  faces,
}: {
  src: string;
  width: number | null;
  height: number | null;
  faces: BoxFace[];
}) {
  return (
    <div className="relative">
      <img src={src} alt="" className="w-full rounded" />
      {width &&
        height &&
        faces.map((face) => {
          const [x1, y1, x2, y2] = face.bbox;
          const colour = personColour(face.person_id);
          return (
            <div
              key={face.face_id}
              className="absolute border-2"
              style={{
                left: `${(x1 / width) * 100}%`,
                top: `${(y1 / height) * 100}%`,
                width: `${((x2 - x1) / width) * 100}%`,
                height: `${((y2 - y1) / height) * 100}%`,
                borderColor: colour,
                borderStyle: face.is_strong ? "solid" : "dashed",
              }}
            >
              <span
                className="absolute left-0 top-0 whitespace-nowrap px-1 text-[10px] leading-4 text-white"
                style={{ background: colour }}
              >
                {face.person_id ? `P${face.person_id}` : "?"} f{face.face_id} q{face.quality.toFixed(2)}
                {face.is_strong ? "" : " weak"}
              </span>
            </div>
          );
        })}
    </div>
  );
}
