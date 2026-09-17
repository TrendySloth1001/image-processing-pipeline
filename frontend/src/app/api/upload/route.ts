import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";

import { ensureSchema, sql } from "@/db";
import { submitJob } from "@/lib/pipeline";
import { putStream } from "@/lib/s3";

export const runtime = "nodejs";
// Never collect the body before handing it over: the point of this route is that a two-gigabyte
// video passes through it without ever being held.
export const dynamic = "force-dynamic";

const VIDEO_EXTENSIONS = [".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi"];

/** Videos are told apart by their type, or by their name when the browser doesn't say. */
function kindOf(name: string, type: string) {
  if (type.startsWith("video/")) return "video" as const;
  const lower = name.toLowerCase();
  return VIDEO_EXTENSIONS.some((extension) => lower.endsWith(extension)) ? ("video" as const) : ("photo" as const);
}

/**
 * One upload: browser -> S3 -> a job on the pipeline's queue. The faces come back by webhook.
 *
 * The file arrives as the raw request body rather than as a form field, and the name and type
 * come in the query, because a multipart form is parsed into memory before a route handler ever
 * sees it. That was fine while everything was a photo and fatal the first time it was a video:
 * the container ran out of memory and was killed, so the upload never even reached the database.
 * Here the body is piped to storage a part at a time and never assembled.
 */
export async function POST(request: Request) {
  await ensureSchema();
  const url = new URL(request.url);
  const name = url.searchParams.get("name") ?? "upload";
  const type = url.searchParams.get("type") ?? "";
  if (!request.body) return Response.json({ error: "no file in the request" }, { status: 400 });

  // A form post would be a multipart body, which is the thing this route exists to avoid: it
  // gets parsed into memory before any of this runs. Say so rather than storing the envelope.
  if ((request.headers.get("content-type") ?? "").startsWith("multipart/form-data")) {
    return Response.json(
      { error: "send the file as the request body with ?name= and ?type=, not as a form" },
      { status: 415 },
    );
  }

  const kind = kindOf(name, type);
  const extension = name.includes(".")
    ? name.slice(name.lastIndexOf(".")).toLowerCase()
    : kind === "video"
      ? ".mp4"
      : ".jpg";
  const key = `uploads/${randomUUID()}${extension}`;

  try {
    await putStream(key, Readable.fromWeb(request.body as never), type || "application/octet-stream");
  } catch (error) {
    return Response.json({ error: `could not store the file: ${String(error)}` }, { status: 500 });
  }

  const [photo] = await sql<{ id: number }[]>`
    INSERT INTO photos (key, name, kind) VALUES (${key}, ${name}, ${kind}) RETURNING id`;
  try {
    const jobId = await submitJob(key, photo.id, kind);
    await sql`UPDATE photos SET job_id = ${jobId} WHERE id = ${photo.id}`;
  } catch (error) {
    await sql`UPDATE photos SET status = 'failed', error = ${String(error)} WHERE id = ${photo.id}`;
    return Response.json({ error: `the pipeline refused the job: ${String(error)}` }, { status: 502 });
  }

  return Response.json({ id: photo.id, kind, key });
}
