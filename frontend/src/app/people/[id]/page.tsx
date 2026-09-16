import Link from "next/link";
import { notFound } from "next/navigation";

import { FaceCrop } from "@/components/FaceCrop";
import { ensureSchema, sql } from "@/db";
import { photoUrl } from "@/lib/photoUrl";

export const dynamic = "force-dynamic";

type Row = {
  face_id: number;
  photo_id: number;
  key: string;
  name: string;
  bbox: number[];
  quality: number;
  is_strong: boolean;
  width: number | null;
  height: number | null;
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
  const { notice } = await searchParams;

  const rows = await sql<Row[]>`
    SELECT f.id AS face_id, f.photo_id, f.bbox, f.quality, f.is_strong, p.key, p.name, p.width, p.height
      FROM faces f JOIN photos p ON p.id = f.photo_id
     WHERE f.person_id = ${Number(id)}
     ORDER BY f.quality DESC`;
  if (rows.length === 0) notFound();

  const others = await sql<{ id: number; photos: number }[]>`
    SELECT p.id, COUNT(DISTINCT f.photo_id)::int AS photos
      FROM people p JOIN faces f ON f.person_id = p.id
     WHERE p.id <> ${Number(id)}
     GROUP BY p.id ORDER BY photos DESC, p.id`;

  const cover = rows[0];
  const photos = [...new Map(rows.map((row) => [row.photo_id, row])).values()];

  return (
    <main className="mx-auto max-w-5xl space-y-6 p-6">
      <Link href="/" className="text-sm text-blue-600">← All people</Link>

      {notice && (
        <p className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-2 text-sm text-blue-900 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-100">
          {notice}
        </p>
      )}

      <div className="flex items-center gap-5">
        <FaceCrop
          photoId={cover.photo_id}
          photoKey={cover.key}
          bbox={cover.bbox}
          width={cover.width}
          height={cover.height}
          size={120}
          className="rounded-full shadow"
        />
        <div>
          <h1 className="font-serif text-3xl">Person {id}</h1>
          <p className="text-sm text-neutral-500">
            {photos.length} photo{photos.length === 1 ? "" : "s"}, {rows.length} face
            {rows.length === 1 ? "" : "s"}
            {rows.some((row) => !row.is_strong) && " (some weak)"}
          </p>
        </div>
      </div>

      {/* Each tile pairs the photo with the face that put it in this group. */}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-1">
        {photos.map((photo) => (
          <a
            key={photo.photo_id}
            href={photoUrl(photo.photo_id, photo.key)}
            target="_blank"
            rel="noreferrer"
            className="relative block"
          >
            <img
              src={photoUrl(photo.photo_id, photo.key)}
              alt={photo.name}
              className="aspect-square w-full rounded object-cover"
            />
            <FaceCrop
              photoId={photo.photo_id}
              photoKey={photo.key}
              bbox={photo.bbox}
              width={photo.width}
              height={photo.height}
              size={44}
              className="absolute bottom-1 right-1 rounded-full shadow ring-2 ring-white/90"
            />
          </a>
        ))}
      </div>

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
                {others.map((person) => (
                  <option key={person.id} value={person.id}>
                    Person {person.id} ({person.photos} photo{person.photos === 1 ? "" : "s"})
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
