import Link from "next/link";
import { notFound } from "next/navigation";

import { FaceOf } from "@/components/FaceCrop";
import { MediaGrid, type Item } from "@/components/MediaGrid";
import { ensureSchema, sql } from "@/db";
import { config } from "@/lib/config";
import { coverFields, coverScore } from "@/lib/cover";
import { facePicture, photoUrl, videoUrl } from "@/lib/photoUrl";

export const dynamic = "force-dynamic";

type Row = {
  face_id: number;
  photo_id: number;
  key: string;
  name: string;
  kind: string;
  bbox: number[];
  quality: number;
  is_strong: boolean;
  width: number | null;
  height: number | null;
  track: number | null;
  track_first_ms: number | null;
  track_last_ms: number | null;
  still_key: string | null;
  still_width: number | null;
  still_height: number | null;
};

type Suggestion = {
  id: number;
  similarity: number;
  photos: number;
  cover: Row | null;
};

export default async function PersonPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ notice?: string }>;
}) {
  await ensureSchema();
  const { id } = await params;
  const person = Number(id);
  const { notice } = await searchParams;

  const rows = await sql<Row[]>`
    SELECT f.id AS face_id, f.photo_id, f.bbox, f.quality, f.is_strong, f.track,
           f.track_first_ms, f.track_last_ms, f.still_key, f.still_width, f.still_height,
           pic.key, pic.name, pic.kind, pic.width, pic.height
      FROM faces f JOIN photos pic ON pic.id = f.photo_id
     WHERE f.person_id = ${person}
     ORDER BY ${coverScore} DESC`;
  if (rows.length === 0) notFound();

  /**
   * Who else in the library looks like this person — the same question the matcher asks, put to
   * you instead of decided. It offers the ones it was not sure enough about to act on: a face
   * too turned, too small or too long ago for the model to be certain, which you can settle in
   * one click. People sharing a photo with this one are left out, and so are people you have
   * already said are different.
   */
  const suggestions = await sql<Suggestion[]>`
    WITH mine AS (SELECT id, embedding, photo_id, track FROM faces WHERE person_id = ${person}),
         scored AS (
           SELECT o.person_id AS id, MAX(1 - (m.embedding <=> o.embedding)) AS similarity
             FROM mine m JOIN faces o ON o.person_id IS NOT NULL AND o.person_id <> ${person}
            GROUP BY o.person_id)
    SELECT s.id, s.similarity,
           (SELECT COUNT(DISTINCT photo_id)::int FROM faces WHERE person_id = s.id) AS photos,
           (SELECT ${coverFields}
              FROM faces f JOIN photos pic ON pic.id = f.photo_id
             WHERE f.person_id = s.id ORDER BY ${coverScore} DESC LIMIT 1) AS cover
      FROM scored s
     WHERE s.similarity >= ${config.suggestFrom}
       AND NOT EXISTS (SELECT 1 FROM mine m JOIN faces o ON o.person_id = s.id
                        WHERE o.photo_id = m.photo_id AND COALESCE(o.track, -1) = COALESCE(m.track, -1))
       AND NOT EXISTS (SELECT 1 FROM links l
                         JOIN faces a ON a.id = l.face_a JOIN faces b ON b.id = l.face_b
                        WHERE l.kind = 'different'
                          AND ((a.person_id = ${person} AND b.person_id = s.id)
                            OR (a.person_id = s.id AND b.person_id = ${person})))
     ORDER BY s.similarity DESC LIMIT 4`;

  const others = await sql<{ id: number; photos: number }[]>`
    SELECT p.id, COUNT(DISTINCT f.photo_id)::int AS photos
      FROM people p JOIN faces f ON f.person_id = p.id
     WHERE p.id <> ${person}
     GROUP BY p.id ORDER BY photos DESC, p.id`;

  const cover = rows[0]; // best first, so this is the picture of them and each tile's is the best of that appearance
  // One tile per photo, and one per appearance in a video: the same person can be on screen
  // twice in one clip, and those are two things to show, not one.
  const tiles = [...new Map(rows.map((row) => [`${row.photo_id}:${row.track ?? ""}`, row])).values()];
  const videos = new Set(rows.filter((row) => row.kind === "video").map((row) => row.photo_id)).size;
  const photos = new Set(rows.filter((row) => row.kind !== "video").map((row) => row.photo_id)).size;

  // Everything the viewer needs, worked out here where the URL helpers are.
  const items: Item[] = tiles.map((tile) => {
    const isVideo = tile.kind === "video";
    const picture = facePicture(tile);
    return {
      id: `${tile.photo_id}:${tile.track ?? ""}`,
      faceId: tile.face_id,
      kind: isVideo ? "video" : "photo",
      name: tile.name,
      frameSrc: isVideo ? picture.src : photoUrl(tile.photo_id, tile.key),
      frameWidth: isVideo ? picture.width : tile.width,
      frameHeight: isVideo ? picture.height : tile.height,
      bbox: tile.bbox,
      videoSrc: isVideo ? videoUrl(tile.photo_id, tile.key) : undefined,
      startMs: tile.track_first_ms ?? undefined,
      endMs: tile.track_last_ms ?? undefined,
    };
  });

  return (
    <main className="mx-auto max-w-5xl space-y-6 p-6">
      <Link href="/" className="text-sm text-blue-600">← All people</Link>

      {notice && (
        <p className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-2 text-sm text-blue-900 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-100">
          {notice}
        </p>
      )}

      <div className="flex items-center gap-5">
        <FaceOf face={cover} size={120} className="rounded-full shadow" />
        <div>
          <h1 className="font-serif text-3xl">Person {id}</h1>
          <p className="text-sm text-neutral-500">
            {[
              photos > 0 && `${photos} photo${photos === 1 ? "" : "s"}`,
              videos > 0 && `${videos} video${videos === 1 ? "" : "s"}`,
              `${rows.length} face${rows.length === 1 ? "" : "s"}`,
            ]
              .filter(Boolean)
              .join(", ")}
            {rows.some((row) => !row.is_strong) && " (some weak)"}
          </p>
        </div>
      </div>

      {suggestions.length > 0 && (
        <section className="rounded-2xl border border-amber-300/60 bg-amber-50 p-5 dark:border-amber-900/60 dark:bg-amber-950/40">
          <h2 className="mb-1 font-medium">Might also be this person</h2>
          <p className="mb-4 text-sm text-neutral-600 dark:text-neutral-400">
            These look like Person {id} but not enough for the app to decide on its own — usually a face
            that is turned away, small in a video frame, or years older. You decide, and regrouping
            remembers it.
          </p>
          <div className="flex flex-wrap gap-5">
            {suggestions.map((suggestion) => (
              <div key={suggestion.id} className="w-32 text-center">
                <Link href={`/people/${suggestion.id}`}>
                  {suggestion.cover && <FaceOf face={suggestion.cover} className="mx-auto rounded-full shadow" />}
                </Link>
                <div className="mt-2 text-sm font-medium">Person {suggestion.id}</div>
                <div className="text-xs text-neutral-500">
                  {suggestion.photos} picture{suggestion.photos === 1 ? "" : "s"} ·{" "}
                  {Number(suggestion.similarity).toFixed(2)} alike
                </div>
                <form action="/api/merge" method="post" className="mt-2">
                  <input type="hidden" name="from" value={suggestion.id} />
                  <input type="hidden" name="into" value={id} />
                  <button type="submit" className="rounded-full bg-blue-600 px-3 py-1.5 text-xs text-white">
                    Same person
                  </button>
                </form>
              </div>
            ))}
          </div>
        </section>
      )}

      <MediaGrid items={items} personId={id} />

      {others.length > 0 && (
        <section className="rounded-2xl border border-black/10 bg-white p-5 dark:border-white/15 dark:bg-neutral-900">
          <h2 className="mb-1 font-medium">Same as someone else?</h2>
          <p className="mb-3 text-sm text-neutral-500">
            Moves these {rows.length} face{rows.length === 1 ? "" : "s"} across and remembers your decision,
            so regrouping won't split them again. Use it when the model can't match a face itself, like a
            profile shot of someone you already have.
          </p>
          <form action="/api/merge" method="post" className="flex flex-wrap items-center gap-3">
            <input type="hidden" name="from" value={id} />
            <label className="text-sm">
              Person {id} is really{" "}
              <select name="into" className="rounded-lg border border-black/15 px-2 py-1.5 text-sm dark:border-white/20 dark:bg-neutral-800">
                {others.map((other) => (
                  <option key={other.id} value={other.id}>
                    Person {other.id} ({other.photos} picture{other.photos === 1 ? "" : "s"})
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" className="rounded-full bg-blue-600 px-4 py-2 text-sm text-white">
              Merge
            </button>
          </form>
        </section>
      )}
    </main>
  );
}
