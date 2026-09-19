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
  blur?: number;
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
  // A JPEG of what the pipeline actually decoded, so the browser never has to open a HEIC.
  preview?: { key: string; width: number; height: number } | null;
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

const asRow = (photoId: number, face: Face, track: Track | null) => ({
  photo_id: photoId,
  bbox: JSON.stringify(face.bbox),
  det_score: face.det_score,
  quality: face.quality,
  is_strong: face.is_strong,
  yaw: face.yaw ?? null,
  blur: face.blur ?? null,
  embedding: toVector(face.embedding),
  track: track?.track ?? null,
  at_ms: face.at_ms ?? null,
  track_first_ms: track?.first_ms ?? null,
  track_last_ms: track?.last_ms ?? null,
  still_key: face.still?.key ?? null,
  still_width: face.still?.width ?? null,
  still_height: face.still?.height ?? null,
});

/**
 * Stores faces and hands back their row ids in the same order.
 *
 * All of them in one statement, not one statement each. A twelve-minute video came back with two
 * hundred appearances and some seven hundred faces, and seven hundred round trips take longer
 * than the pipeline waits for an answer — so the delivery would time out, be retried, and take
 * just as long again, for ever.
 */
async function insertFaces(rows: ReturnType<typeof asRow>[]): Promise<number[]> {
  if (rows.length === 0) return [];
  const inserted = await sql<{ id: number }[]>`INSERT INTO faces ${sql(rows)} RETURNING id`;
  return inserted.map((row) => row.id);
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
    const tracks = result.tracks ?? [];
    const ids = await insertFaces(tracks.flatMap((track) => track.faces.map((face) => asRow(photoId, face, track))));
    let at = 0;
    for (const track of tracks) {
      const stored = track.faces.map((face, index) => ({
        id: ids[at + index],
        embedding: face.embedding,
        isStrong: face.is_strong,
        yaw: face.yaw ?? null,
      }));
      at += track.faces.length;
      await assignTrack(photoId, track, stored);
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

  const faces = result.faces ?? [];
  const ids = await insertFaces(faces.map((face) => asRow(photoId, face, null)));
  for (const [index, face] of faces.entries()) {
    await assignPerson(ids[index], photoId, face.embedding, face.is_strong, face.yaw ?? null);
  }

  await sql`
    UPDATE photos
       SET status = 'processed', width = ${result.image?.width ?? null}, height = ${result.image?.height ?? null},
           poster_key = COALESCE(${result.preview?.key ?? null}, poster_key), error = NULL
     WHERE id = ${photoId}`;

  return Response.json({ received: true, faces: result.faces?.length ?? 0 });
}
