import Link from "next/link";

import { FaceCrop } from "@/components/FaceCrop";
import { ensureSchema, sql } from "@/db";
import { photoUrl } from "@/lib/photoUrl";

export const dynamic = "force-dynamic";

type Person = {
  id: number;
  photos: number;
  faces: number;
  cover: {
    photoId: number;
    key: string;
    bbox: number[];
    width: number | null;
    height: number | null;
  } | null;
};

type Photo = {
  id: number;
  key: string;
  name: string;
  status: string;
  faces: number;
};

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ notice?: string; error?: string }>;
}) {
  await ensureSchema();
  const { notice, error } = await searchParams;

  const people = await sql<Person[]>`
    SELECT p.id,
           COUNT(DISTINCT f.photo_id)::int AS photos,
           COUNT(f.id)::int AS faces,
           (SELECT json_build_object('photoId', best.photo_id, 'key', ph.key, 'bbox', best.bbox,
                                     'width', ph.width, 'height', ph.height)
              FROM faces best JOIN photos ph ON ph.id = best.photo_id
             WHERE best.person_id = p.id
             ORDER BY best.quality DESC LIMIT 1) AS cover
      FROM people p JOIN faces f ON f.person_id = p.id
     GROUP BY p.id
     ORDER BY photos DESC, p.id`;

  const photos = await sql<Photo[]>`
    SELECT id, key, name, status, (SELECT COUNT(*)::int FROM faces WHERE photo_id = photos.id) AS faces
      FROM photos ORDER BY id DESC LIMIT 60`;

  const pending = photos.filter((photo) => photo.status === "queued").length;
  const unassigned = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int AS count FROM faces WHERE person_id IS NULL`;

  return (
    <main className="mx-auto max-w-5xl space-y-6 p-6">
      {/* While photos are still in the pipeline, refresh until the webhooks have landed. */}
      {pending > 0 && <meta httpEquiv="refresh" content="3" />}

      <h1 className="font-serif text-3xl">People</h1>

      {notice && (
        <p className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-2 text-sm text-blue-900 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-100">
          {notice}
        </p>
      )}
      {error && (
        <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-100">
          {error}
        </p>
      )}

      <section className="rounded-2xl border border-black/10 bg-white p-5 dark:border-white/15 dark:bg-neutral-900">
        <h2 className="mb-3 font-medium">Add photos</h2>
        <form action="/api/upload" method="post" encType="multipart/form-data" className="flex flex-wrap items-center gap-3">
          <input type="file" name="files" multiple accept="image/*" required className="text-sm" />
          <button type="submit" className="rounded-full bg-blue-600 px-4 py-2 text-sm text-white">Upload</button>
          <span className="text-sm text-neutral-500">
            Uploads go to S3, then the queue. Faces come back by webhook.
          </span>
        </form>
      </section>

      <section className="rounded-2xl border border-black/10 bg-white p-5 dark:border-white/15 dark:bg-neutral-900">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-medium">
            {people.length} {people.length === 1 ? "person" : "people"}
            {unassigned[0].count > 0 && (
              <span className="ml-2 text-sm text-neutral-500">{unassigned[0].count} faces unassigned</span>
            )}
          </h2>
          <div className="flex items-center gap-4">
            <Link href="/inspect" className="text-sm text-blue-600">Face mappings</Link>
            <form action="/api/regroup" method="post">
              <button type="submit" className="rounded-full border border-black/15 px-3 py-1.5 text-sm dark:border-white/20">
                Regroup everything
              </button>
            </form>
          </div>
        </div>

        {people.length === 0 ? (
          <p className="text-sm text-neutral-500">Nobody yet. Upload a few photos.</p>
        ) : (
          <div className="flex flex-wrap gap-5">
            {people.map((person, index) => (
              <Link key={person.id} href={`/people/${person.id}`} className="w-28 text-center">
                {person.cover && (
                  <FaceCrop
                    photoId={person.cover.photoId}
                    photoKey={person.cover.key}
                    bbox={person.cover.bbox}
                    width={person.cover.width}
                    height={person.cover.height}
                    className="mx-auto rounded-full shadow"
                  />
                )}
                <div className="mt-2 text-sm font-medium">Person {index + 1}</div>
                <div className="text-xs text-neutral-500">
                  {person.photos} photo{person.photos === 1 ? "" : "s"}
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>

      <section className="rounded-2xl border border-black/10 bg-white p-5 dark:border-white/15 dark:bg-neutral-900">
        <div className="mb-3 flex items-center justify-between gap-4">
          <h2 className="font-medium">
            {photos.length} photo{photos.length === 1 ? "" : "s"}
            {pending > 0 && <span className="ml-2 text-sm text-neutral-500">{pending} still processing…</span>}
          </h2>
          {photos.length > 0 && (
            <form action="/api/reset" method="post">
              <button
                type="submit"
                className="rounded-full border border-red-500/40 px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-950"
              >
                Delete all photos and data
              </button>
            </form>
          )}
        </div>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(110px,1fr))] gap-2">
          {photos.map((photo) => (
            <div key={photo.id} className="relative">
              <img
                src={photoUrl(photo.id, photo.key)}
                alt={photo.name}
                className="aspect-square w-full rounded object-cover"
              />
              <span className="absolute bottom-1 left-1 rounded bg-black/60 px-1.5 text-[11px] text-white">
                {photo.status === "queued" ? "queued" : photo.status === "failed" ? "failed" : `${photo.faces} faces`}
              </span>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
