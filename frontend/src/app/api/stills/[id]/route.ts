import { createHash } from "node:crypto";

import { ensureSchema, sql } from "@/db";
import { getObjectStream } from "@/lib/s3";

export const runtime = "nodejs";

/**
 * Serves the still that goes with one face out of a video.
 *
 * The key is looked up by face id rather than taken from the URL, so this can never be asked
 * for an arbitrary object in the bucket. Like the photo route, the key is the ETag: stills are
 * written once and never change, so the browser revalidates and usually gets a 304.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  await ensureSchema();
  const { id } = await params;
  const [face] = await sql<{ still_key: string | null }[]>`
    SELECT still_key FROM faces WHERE id = ${Number(id)}`;
  if (!face?.still_key) return new Response("not found", { status: 404 });

  const etag = `"${createHash("sha1").update(face.still_key).digest("hex")}"`;
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { etag, "cache-control": "private, no-cache" } });
  }

  const object = await getObjectStream(face.still_key);
  return new Response(object.body as BodyInit, {
    headers: { "content-type": object.contentType, etag, "cache-control": "private, no-cache" },
  });
}
