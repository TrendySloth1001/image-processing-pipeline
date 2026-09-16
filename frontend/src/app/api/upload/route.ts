import { randomUUID } from "node:crypto";

import { ensureSchema, sql } from "@/db";
import { submitJob } from "@/lib/pipeline";
import { putObject } from "@/lib/s3";

export const runtime = "nodejs";

const VIDEO_EXTENSIONS = [".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi"];

/** Videos are told apart by their type, or by their name when the browser doesn't say. */
function kindOf(file: File) {
  if (file.type.startsWith("video/")) return "video" as const;
  const name = file.name.toLowerCase();
  return VIDEO_EXTENSIONS.some((extension) => name.endsWith(extension)) ? ("video" as const) : ("photo" as const);
}

/** Browser upload -> S3 -> a job on the pipeline's queue. The faces come back by webhook. */
export async function POST(request: Request) {
  await ensureSchema();
  const form = await request.formData();
  const files = form.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);

  for (const file of files) {
    const kind = kindOf(file);
    const extension = file.name.includes(".")
      ? file.name.slice(file.name.lastIndexOf(".")).toLowerCase()
      : kind === "video"
        ? ".mp4"
        : ".jpg";
    const key = `uploads/${randomUUID()}${extension}`;
    await putObject(key, Buffer.from(await file.arrayBuffer()), file.type || "image/jpeg");

    const [photo] = await sql<{ id: number }[]>`
      INSERT INTO photos (key, name, kind) VALUES (${key}, ${file.name}, ${kind}) RETURNING id`;
    try {
      const jobId = await submitJob(key, photo.id, kind);
      await sql`UPDATE photos SET job_id = ${jobId} WHERE id = ${photo.id}`;
    } catch (error) {
      await sql`UPDATE photos SET status = 'failed', error = ${String(error)} WHERE id = ${photo.id}`;
    }
  }

  return Response.redirect(new URL("/", request.url), 303);
}
