import { ensureSchema, sql } from "@/db";
import { deleteObjects, listKeys } from "@/lib/s3";
import { goTo } from "@/lib/redirect";

export const runtime = "nodejs";

/**
 * Start over: empty the three tables and delete the uploaded photos from S3.
 * The pipeline keeps nothing of its own, so this clears everything the app owns.
 */
export async function POST(request: Request) {
  await ensureSchema();

  const rows = await sql<{ key: string }[]>`SELECT key FROM photos`;
  const keys = new Set(rows.map((row) => row.key));
  for (const key of await listKeys("uploads/")) keys.add(key); // orphans from failed uploads
  for (const key of await listKeys("stills/")) keys.add(key); // face stills cut out of videos
  const removed = await deleteObjects([...keys]);

  const [counts] = await sql<{ photos: number; faces: number; people: number }[]>`
    SELECT (SELECT count(*)::int FROM photos) AS photos,
           (SELECT count(*)::int FROM faces) AS faces,
           (SELECT count(*)::int FROM people) AS people`;
  await sql`TRUNCATE faces, people, photos RESTART IDENTITY CASCADE`;

  const notice = `Deleted ${counts.photos} photos, ${counts.faces} faces and ${counts.people} people, and removed ${removed} files from storage.`;
  return goTo("/", notice);
}
