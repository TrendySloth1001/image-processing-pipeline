import { createHmac, timingSafeEqual } from "node:crypto";

import { ensureSchema, sql } from "@/db";
import { config } from "@/lib/config";
import { assignPerson, assignTrack, toVector } from "@/lib/grouping";

export const runtime = "nodejs";

type Face = {
  bbox: number[];
  det_score: number;
  quality: number;
  is_strong: boolean;
  yaw?: number;
  embedding: number[];
  at_ms?: number;
  still?: { key: string; width: number; height: number };
};

type Track = {
  track: number;
  first_ms: number;
  last_ms: number;
  frames: number;
  faces: Face[];
};

type Result = {
  job_id: string;
  kind?: "image" | "video";
  status: "succeeded" | "failed";
  metadata?: { photoId?: number };
  image?: { width: number; height: number };
  video?: {
    width: number;
    height: number;
    duration_ms: number;
    sampled_frames: number;
    poster?: { key: string; width: number; height: number } | null;
  };
  faces?: Face[];
  tracks?: Track[];
  error?: string;
};

function signatureMatches(body: string, header: string | null) {
  const expected = "sha256=" + createHmac("sha256", config.webhookSecret).update(body).digest("hex");
  const given = header ?? "";
  return expected.length === given.length && timingSafeEqual(Buffer.from(expected), Buffer.from(given));
}

/** Stores one face and hands back its row id, so the grouping can be decided afterwards. */
async function insertFace(photoId: number, face: Face, track: Track | null) {
  const [row] = await sql<{ id: number }[]>`
    INSERT INTO faces (photo_id, bbox, det_score, quality, is_strong, yaw, embedding,
                       track, at_ms, track_first_ms, track_last_ms,
                       still_key, still_width, still_height)
    VALUES (${photoId}, ${JSON.stringify(face.bbox)}::jsonb, ${face.det_score}, ${face.quality},
            ${face.is_strong}, ${face.yaw ?? null}, ${toVector(face.embedding)}::vector,
            ${track?.track ?? null}, ${face.at_ms ?? null}, ${track?.first_ms ?? null},
            ${track?.last_ms ?? null}, ${face.still?.key ?? null},
            ${face.still?.width ?? null}, ${face.still?.height ?? null})
    RETURNING id`;
  return row.id;
}

/**
 * The pipeline delivers here and retries until we answer 2xx, so this has to be safe to run
 * twice for the same job: the faces of a photo are replaced, never appended.
 *
 * A video arrives as tracks instead of faces. Each track is one person's appearance, so its
 * faces are stored together and grouped together — see assignTrack.
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

  if (result.kind === "video") {
    for (const track of result.tracks ?? []) {
      const stored = [];
      for (const face of track.faces) {
        stored.push({
          id: await insertFace(photoId, face, track),
          embedding: face.embedding,
          isStrong: face.is_strong,
          yaw: face.yaw ?? null,
        });
      }
      await assignTrack(photoId, stored);
    }
    const video = result.video;
    await sql`
      UPDATE photos
         SET status = 'processed', kind = 'video', width = ${video?.poster?.width ?? null},
             height = ${video?.poster?.height ?? null}, duration_ms = ${video?.duration_ms ?? null},
             poster_key = ${video?.poster?.key ?? null}, error = NULL
       WHERE id = ${photoId}`;
    return Response.json({ received: true, tracks: result.tracks?.length ?? 0 });
  }

  for (const face of result.faces ?? []) {
    const faceId = await insertFace(photoId, face, null);
    await assignPerson(faceId, photoId, face.embedding, face.is_strong, face.yaw ?? null);
  }

  await sql`
    UPDATE photos
       SET status = 'processed', width = ${result.image?.width ?? null}, height = ${result.image?.height ?? null},
           error = NULL
     WHERE id = ${photoId}`;

  return Response.json({ received: true, faces: result.faces?.length ?? 0 });
}
