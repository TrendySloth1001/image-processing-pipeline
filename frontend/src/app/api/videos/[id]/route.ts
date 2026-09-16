import { ensureSchema, sql } from "@/db";
import { getObjectRange } from "@/lib/s3";

export const runtime = "nodejs";

/**
 * Plays a video out of storage, so the bucket can stay private.
 *
 * Range requests are answered properly — a 206 with the bytes asked for — because without them
 * a browser cannot seek, and it has to download the whole file before it will play anything.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  await ensureSchema();
  const { id } = await params;
  const [photo] = await sql<{ key: string }[]>`
    SELECT key FROM photos WHERE id = ${Number(id)} AND kind = 'video'`;
  if (!photo) return new Response("not found", { status: 404 });

  const range = request.headers.get("range");
  const object = await getObjectRange(photo.key, range);

  const headers: Record<string, string> = {
    "content-type": object.contentType,
    "accept-ranges": "bytes",
    "cache-control": "private, no-cache",
  };
  if (object.contentLength !== null) headers["content-length"] = String(object.contentLength);
  if (object.contentRange) headers["content-range"] = object.contentRange;

  return new Response(object.body as BodyInit, {
    status: object.contentRange ? 206 : 200,
    headers,
  });
}
