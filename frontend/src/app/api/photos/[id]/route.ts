import { createHash } from "node:crypto";

import { ensureSchema, sql } from "@/db";
import { getObjectStream } from "@/lib/s3";

export const runtime = "nodejs";

/**
 * Serves a photo from S3, so the bucket can stay private. For a video this serves its poster
 * frame, so anywhere the app shows a picture it can show a video too, unchanged.
 *
 * The id is a row id, and row ids come round again after the table is cleared, so the browser
 * must not keep an old photo under the same URL. The object key is unique per upload, so it
 * becomes the ETag: the browser revalidates, and gets a 304 whenever the photo really is the same.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  await ensureSchema();
  const { id } = await params;
  const [photo] = await sql<{ key: string; kind: string; poster_key: string | null }[]>`
    SELECT key, kind, poster_key FROM photos WHERE id = ${Number(id)}`;
  if (!photo) return new Response("not found", { status: 404 });
  // A video has no poster until the pipeline has cut one; serving the video itself to an <img>
  // would only give the browser something it cannot draw.
  if (photo.kind === "video" && !photo.poster_key) return new Response("no poster yet", { status: 404 });
  const key = photo.poster_key ?? photo.key;

  const etag = `"${createHash("sha1").update(key).digest("hex")}"`;
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { etag, "cache-control": "private, no-cache" } });
  }

  const object = await getObjectStream(key);
  return new Response(object.body as BodyInit, {
    headers: { "content-type": object.contentType, etag, "cache-control": "private, no-cache" },
  });
}
