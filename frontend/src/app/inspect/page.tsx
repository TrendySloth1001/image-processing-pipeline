import Link from "next/link";

import { FaceBoxes, personColour } from "@/components/FaceBoxes";
import { clock } from "@/components/MediaTile";
import { ensureSchema, sql } from "@/db";
import { facePicture, photoUrl } from "@/lib/photoUrl";

export const dynamic = "force-dynamic";

type Row = {
  face_id: number;
  photo_id: number;
  key: string;
  name: string;
  kind: string;
  width: number | null;
  height: number | null;
  bbox: number[];
  det_score: number;
  quality: number;
  is_strong: boolean;
  person_id: number | null;
  matched_face_id: number | null;
  match_similarity: number | null;
  assigned_by: string | null;
  track: number | null;
  at_ms: number | null;
  track_first_ms: number | null;
  track_last_ms: number | null;
  still_key: string | null;
  still_width: number | null;
  still_height: number | null;
};

const MATRIX_LIMIT = 30; // the similarity table gets unreadable beyond this

/** The table under each picture: which face matched what, and who decided. */
function Decisions({ faces }: { faces: Row[] }) {
  return (
    <table className="w-full text-left text-xs">
      <thead className="text-neutral-500">
        <tr>
          <th className="py-1">face</th>
          <th>person</th>
          <th>size</th>
          <th>detect</th>
          <th>quality</th>
          <th>matched</th>
          <th>decided by</th>
        </tr>
      </thead>
      <tbody>
        {faces.map((face) => (
          <tr key={face.face_id} className="border-t border-black/5 dark:border-white/10">
            <td className="py-1">f{face.face_id}</td>
            <td>
              <span className="rounded px-1.5 py-0.5 text-white" style={{ background: personColour(face.person_id) }}>
                {face.person_id ? `P${face.person_id}` : "unassigned"}
              </span>
            </td>
            <td>{Math.round(face.bbox[2] - face.bbox[0])}px</td>
            <td>{face.det_score.toFixed(2)}</td>
            <td>
              {face.quality.toFixed(2)}
              {face.is_strong ? "" : " weak"}
            </td>
            <td>
              {face.match_similarity === null
                ? "—"
                : `${face.matched_face_id ? `f${face.matched_face_id}` : "group average"} ${Number(
                    face.match_similarity,
                  ).toFixed(2)}`}
            </td>
            <td className="text-neutral-500">{face.assigned_by ?? "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default async function InspectPage() {
  await ensureSchema();

  const rows = await sql<Row[]>`
    SELECT f.id AS face_id, f.photo_id, p.key, p.name, p.kind, p.width, p.height, f.bbox, f.det_score,
           f.quality, f.is_strong, f.person_id, f.matched_face_id, f.match_similarity, f.assigned_by,
           f.track, f.at_ms, f.track_first_ms, f.track_last_ms, f.still_key, f.still_width, f.still_height
      FROM faces f JOIN photos p ON p.id = f.photo_id
     ORDER BY f.photo_id DESC, f.track NULLS FIRST, f.id`;

  // Photos are shown whole, with every face boxed on them. A video has no single picture to box
  // faces on, so it is shown appearance by appearance, each as the stills the pipeline kept.
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const key = row.kind === "video" ? `${row.photo_id}:${row.track ?? ""}` : `${row.photo_id}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }

  // Only the faces the matrix shows, so a big library doesn't turn into a huge query.
  const ids = [...rows]
    .sort((x, y) => (x.person_id ?? 1e9) - (y.person_id ?? 1e9) || x.face_id - y.face_id)
    .map((row) => row.face_id)
    .slice(0, MATRIX_LIMIT);
  const pairs = ids.length
    ? await sql<{ a: number; b: number; similarity: number }[]>`
        SELECT a.id AS a, b.id AS b, (1 - (a.embedding <=> b.embedding)) AS similarity
          FROM faces a JOIN faces b ON a.id < b.id
         WHERE a.id IN ${sql(ids)} AND b.id IN ${sql(ids)}`
    : [];
  const similarity = new Map(pairs.map((pair) => [`${pair.a}:${pair.b}`, Number(pair.similarity)]));
  const personOf = new Map(rows.map((row) => [row.face_id, row.person_id]));

  return (
    <main className="mx-auto max-w-6xl space-y-6 p-6">
      <Link href="/" className="text-sm text-blue-600">← All people</Link>
      <h1 className="font-serif text-3xl">Face mappings</h1>
      <p className="max-w-3xl text-sm text-neutral-500">
        Every face the pipeline found, boxed on its picture. The colour and <b>P8</b> label are the person it
        was put with, <b>f12</b> is the face id, <b>q</b> is its quality score, and a dashed box means a weak
        face: too small, blurry or turned to start a group, so it could only join one. The table under each
        picture shows which face it was compared against and how close they were, on a scale where 1 is
        identical. A video is listed one appearance at a time — the few frames kept out of it — because
        every face of an appearance is grouped as one.
      </p>

      {[...groups.values()].map((faces) => {
        const first = faces[0];
        if (first.kind === "video") {
          return (
            <section
              key={`${first.photo_id}:${first.track}`}
              className="rounded-2xl border border-black/10 bg-white p-5 dark:border-white/15 dark:bg-neutral-900"
            >
              <h2 className="mb-1 truncate font-medium">{first.name}</h2>
              <p className="mb-3 text-xs text-neutral-500">
                video {first.photo_id} · appearance {first.track} · {clock(first.track_first_ms ?? 0)}–
                {clock(first.track_last_ms ?? 0)} · {faces.length} face{faces.length === 1 ? "" : "s"} kept
              </p>
              <div className="mb-4 flex flex-wrap gap-3">
                {faces.map((face) => (
                  <div key={face.face_id} className="w-40">
                    <FaceBoxes
                      src={facePicture(face).src}
                      width={face.still_width}
                      height={face.still_height}
                      faces={[face]}
                    />
                    <p className="mt-1 text-center text-[11px] text-neutral-500">at {clock(face.at_ms ?? 0)}</p>
                  </div>
                ))}
              </div>
              <Decisions faces={faces} />
            </section>
          );
        }
        return (
          <section
            key={first.photo_id}
            className="grid gap-5 rounded-2xl border border-black/10 bg-white p-5 md:grid-cols-[minmax(0,420px)_1fr] dark:border-white/15 dark:bg-neutral-900"
          >
            <FaceBoxes
              src={photoUrl(first.photo_id, first.key)}
              width={first.width}
              height={first.height}
              faces={faces}
            />
            <div className="min-w-0">
              <h2 className="mb-1 truncate font-medium">{first.name}</h2>
              <p className="mb-3 text-xs text-neutral-500">
                photo {first.photo_id} · {first.width}×{first.height} · {faces.length} face
                {faces.length === 1 ? "" : "s"}
              </p>
              <Decisions faces={faces} />
            </div>
          </section>
        );
      })}

      {ids.length > 1 && (
        <section className="overflow-x-auto rounded-2xl border border-black/10 bg-white p-5 dark:border-white/15 dark:bg-neutral-900">
          <h2 className="mb-1 font-medium">How similar every face is to every other</h2>
          <p className="mb-3 text-xs text-neutral-500">
            Cosine similarity between the 512-number embeddings, grouped by person. Green is the same-person
            range, grey is clearly different people. Faces of one person should form a solid green block.
          </p>
          <table className="text-[11px]">
            <thead>
              <tr>
                <th className="p-1"></th>
                {ids.map((id) => (
                  <th key={id} className="p-1 font-normal" style={{ color: personColour(personOf.get(id) ?? null) }}>
                    f{id}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ids.map((a) => (
                <tr key={a}>
                  <td className="p-1 font-medium" style={{ color: personColour(personOf.get(a) ?? null) }}>
                    f{a}
                  </td>
                  {ids.map((b) => {
                    const value = a === b ? 1 : (similarity.get(`${a}:${b}`) ?? similarity.get(`${b}:${a}`) ?? 0);
                    const strength = Math.max(0, Math.min(1, (value - 0.2) / 0.6));
                    return (
                      <td
                        key={b}
                        className="p-1 text-center tabular-nums"
                        style={{
                          background: `rgba(22, 163, 74, ${strength * 0.55})`,
                          color: strength > 0.6 ? "#052e16" : undefined,
                        }}
                      >
                        {value.toFixed(2)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </main>
  );
}
