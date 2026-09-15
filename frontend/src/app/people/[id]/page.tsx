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

export default async function PersonPage({ params }: { params: Promise<{ id: string }> }) {
  await ensureSchema();
  const { id } = await params;

  const rows = await sql<Row[]>`
    SELECT f.id AS face_id, f.photo_id, f.bbox, f.quality, f.is_strong, p.key, p.name, p.width, p.height
      FROM faces f JOIN photos p ON p.id = f.photo_id
     WHERE f.person_id = ${Number(id)}
     ORDER BY f.quality DESC`;
  if (rows.length === 0) notFound();

  const cover = rows[0];
  const photos = [...new Map(rows.map((row) => [row.photo_id, row])).values()];

  return (
    <main className="mx-auto max-w-5xl space-y-6 p-6">
      <Link href="/" className="text-sm text-blue-600">← All people</Link>

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
              className="absolute bottom-1 right-1 rounded-full ring-2 ring-white/90 shadow"
            />
          </a>
        ))}
      </div>
    </main>
  );
}
