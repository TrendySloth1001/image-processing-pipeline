import { createHash } from "node:crypto";

import { ensureSchema, sql } from "@/db";
import { getObjectStream } from "@/lib/s3";

export const runtime = "nodejs";

/**
 * Serves a photo from S3, so the bucket can stay private.
 *
 * The id is a row id, and row ids come round again after the table is cleared, so the browser
 * must not keep an old photo under the same URL. The object key is unique per upload, so it
 * becomes the ETag: the browser revalidates, and gets a 304 whenever the photo really is the same.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  await ensureSchema();
  const { id } = await params;
  const [photo] = await sql<{ key: string }[]>`SELECT key FROM photos WHERE id = ${Number(id)}`;
  if (!photo) return new Response("not found", { status: 404 });

  const etag = `"${createHash("sha1").update(photo.key).digest("hex")}"`;
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { etag, "cache-control": "private, no-cache" } });
  }

  const object = await getObjectStream(photo.key);
  return new Response(object.body as BodyInit, {
    headers: { "content-type": object.contentType, etag, "cache-control": "private, no-cache" },
  });
}
