import { boolean, integer, jsonb, pgTable, real, serial, text, timestamp, vector } from "drizzle-orm/pg-core";

/** One upload: a photo, or a video. The bytes live in S3; only the key is kept here. */
export const photos = pgTable("photos", {
  id: serial("id").primaryKey(),
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  kind: text("kind").notNull().default("photo"), // photo | video
  jobId: text("job_id"),
  status: text("status").notNull().default("queued"), // queued | processed | failed
  width: integer("width"), // of the photo, or of the video's poster frame
  height: integer("height"),
  durationMs: integer("duration_ms"), // videos only
  posterKey: text("poster_key"), // videos only: the frame shown in place of the video
  error: text("error"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

/** A person is just an id; faces point at it. */
export const people = pgTable("people", {
  id: serial("id").primaryKey(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

/** One face found in one photo, with the 512-number ArcFace embedding and why it was grouped.
 *
 * A face from a video also names its track — one person's continuous appearance — and the
 * moment it was seen. Its bbox is in the pixels of `stillKey`, the JPEG the pipeline cut for it,
 * because that still is the picture the app shows, not the video. */
export const faces = pgTable("faces", {
  id: serial("id").primaryKey(),
  photoId: integer("photo_id").notNull(),
  personId: integer("person_id"),
  bbox: jsonb("bbox").$type<number[]>().notNull(), // x1, y1, x2, y2 in photo (or still) pixels
  track: integer("track"), // videos only
  atMs: integer("at_ms"), // videos only: when in the video this face was seen
  trackFirstMs: integer("track_first_ms"), // videos only: when the whole appearance began
  trackLastMs: integer("track_last_ms"), // ...and ended
  stillKey: text("still_key"), // videos only
  stillWidth: integer("still_width"),
  stillHeight: integer("still_height"),
  detScore: real("det_score").notNull(),
  quality: real("quality").notNull(),
  isStrong: boolean("is_strong").notNull(),
  embedding: vector("embedding", { dimensions: 512 }).notNull(),
  matchedFaceId: integer("matched_face_id"), // the face it was compared against
  matchSimilarity: real("match_similarity"), // how close they were, 1 = identical
  assignedBy: text("assigned_by"), // arrival | regroup | new person | too far
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
