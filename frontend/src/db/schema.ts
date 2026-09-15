import { boolean, integer, jsonb, pgTable, real, serial, text, timestamp, vector } from "drizzle-orm/pg-core";

/** One uploaded photo. The bytes live in S3; only the key is kept here. */
export const photos = pgTable("photos", {
  id: serial("id").primaryKey(),
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  jobId: text("job_id"),
  status: text("status").notNull().default("queued"), // queued | processed | failed
  width: integer("width"),
  height: integer("height"),
  error: text("error"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

/** A person is just an id; faces point at it. */
export const people = pgTable("people", {
  id: serial("id").primaryKey(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

/** One face found in one photo, with the 512-number ArcFace embedding and why it was grouped. */
export const faces = pgTable("faces", {
  id: serial("id").primaryKey(),
  photoId: integer("photo_id").notNull(),
  personId: integer("person_id"),
  bbox: jsonb("bbox").$type<number[]>().notNull(), // x1, y1, x2, y2 in photo pixels
  detScore: real("det_score").notNull(),
  quality: real("quality").notNull(),
  isStrong: boolean("is_strong").notNull(),
  embedding: vector("embedding", { dimensions: 512 }).notNull(),
  matchedFaceId: integer("matched_face_id"), // the face it was compared against
  matchSimilarity: real("match_similarity"), // how close they were, 1 = identical
  assignedBy: text("assigned_by"), // arrival | regroup | new person | too far
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
