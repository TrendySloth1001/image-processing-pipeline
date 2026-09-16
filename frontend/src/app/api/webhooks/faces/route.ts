import { createHmac, timingSafeEqual } from "node:crypto";

import { ensureSchema, sql } from "@/db";
import { config } from "@/lib/config";
import { assignPerson, toVector } from "@/lib/grouping";

export const runtime = "nodejs";

type Face = {
  bbox: number[];
  det_score: number;
  quality: number;
  is_strong: boolean;
  yaw?: number;
  embedding: number[];
};

type Result = {
  job_id: string;
  status: "succeeded" | "failed";
  metadata?: { photoId?: number };
  image?: { width: number; height: number };
  faces?: Face[];
  error?: string;
};

function signatureMatches(body: string, header: string | null) {
  const expected = "sha256=" + createHmac("sha256", config.webhookSecret).update(body).digest("hex");
  const given = header ?? "";
  return expected.length === given.length && timingSafeEqual(Buffer.from(expected), Buffer.from(given));
}

/**
 * The pipeline delivers here and retries until we answer 2xx, so this has to be safe to run
 * twice for the same job: the faces of a photo are replaced, never appended.
 */
export async function POST(request: Request) {
  const body = await request.text();
  if (!signatureMatches(body, request.headers.get("x-face-signature"))) {
    return new Response("bad signature", { status: 401 });
  }

  const result = JSON.parse(body) as Result;
  const photoId = result.metadata?.photoId;
  if (!photoId) return new Response("no photoId in metadata", { status: 400 });

  await ensureSchema();

  if (result.status === "failed") {
    await sql`UPDATE photos SET status = 'failed', error = ${result.error ?? "unknown"} WHERE id = ${photoId}`;
    return Response.json({ received: true });
  }

  await sql`DELETE FROM faces WHERE photo_id = ${photoId}`;
  for (const face of result.faces ?? []) {
    const [row] = await sql<{ id: number }[]>`
      INSERT INTO faces (photo_id, bbox, det_score, quality, is_strong, yaw, embedding)
      VALUES (${photoId}, ${JSON.stringify(face.bbox)}::jsonb, ${face.det_score}, ${face.quality},
              ${face.is_strong}, ${face.yaw ?? null}, ${toVector(face.embedding)}::vector)
      RETURNING id`;
    await assignPerson(row.id, photoId, face.embedding, face.is_strong, face.yaw ?? null);
  }

  await sql`
    UPDATE photos
       SET status = 'processed', width = ${result.image?.width ?? null}, height = ${result.image?.height ?? null},
           error = NULL
     WHERE id = ${photoId}`;

  return Response.json({ received: true, faces: result.faces?.length ?? 0 });
}
