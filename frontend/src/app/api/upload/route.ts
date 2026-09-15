import { randomUUID } from "node:crypto";

import { ensureSchema, sql } from "@/db";
import { submitJob } from "@/lib/pipeline";
import { putObject } from "@/lib/s3";

export const runtime = "nodejs";

/** Browser upload -> S3 -> a job on the pipeline's queue. The faces come back by webhook. */
export async function POST(request: Request) {
  await ensureSchema();
  const form = await request.formData();
  const files = form.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);

  for (const file of files) {
    const extension = file.name.includes(".") ? file.name.slice(file.name.lastIndexOf(".")) : ".jpg";
    const key = `uploads/${randomUUID()}${extension.toLowerCase()}`;
    await putObject(key, Buffer.from(await file.arrayBuffer()), file.type || "image/jpeg");

    const [photo] = await sql<{ id: number }[]>`
      INSERT INTO photos (key, name) VALUES (${key}, ${file.name}) RETURNING id`;
    try {
      const jobId = await submitJob(key, photo.id);
      await sql`UPDATE photos SET job_id = ${jobId} WHERE id = ${photo.id}`;
    } catch (error) {
      await sql`UPDATE photos SET status = 'failed', error = ${String(error)} WHERE id = ${photo.id}`;
    }
  }

  return Response.redirect(new URL("/", request.url), 303);
}
