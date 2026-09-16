import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { config } from "@/lib/config";
import * as schema from "./schema";

/** One pool for the process. `sql` is used directly for the vector queries. */
export const sql = postgres(config.databaseUrl, { max: 5 });
export const db = drizzle(sql, { schema });

const DDL = [
  `CREATE EXTENSION IF NOT EXISTS vector`,
  `CREATE TABLE IF NOT EXISTS photos (
     id serial PRIMARY KEY,
     key text UNIQUE NOT NULL,
     name text NOT NULL,
     job_id text,
     status text NOT NULL DEFAULT 'queued',
     width integer,
     height integer,
     error text,
     created_at timestamp NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS people (
     id serial PRIMARY KEY,
     created_at timestamp NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS faces (
     id serial PRIMARY KEY,
     photo_id integer NOT NULL REFERENCES photos (id) ON DELETE CASCADE,
     person_id integer REFERENCES people (id) ON DELETE SET NULL,
     bbox jsonb NOT NULL,
     det_score real NOT NULL,
     quality real NOT NULL,
     is_strong boolean NOT NULL,
     embedding vector(512) NOT NULL,
     created_at timestamp NOT NULL DEFAULT now()
   )`,
  // Why this face ended up with this person: the face it matched, how close they were, and which pass decided.
  `ALTER TABLE faces ADD COLUMN IF NOT EXISTS matched_face_id integer`,
  `ALTER TABLE faces ADD COLUMN IF NOT EXISTS match_similarity real`,
  `ALTER TABLE faces ADD COLUMN IF NOT EXISTS assigned_by text`,
  `ALTER TABLE faces ADD COLUMN IF NOT EXISTS yaw real`,  // how far the head is turned
  // "These two faces are the same person", recorded when you merge two people by hand.
  // Regrouping honours these, so a merge is not undone by the next clustering pass.
  `CREATE TABLE IF NOT EXISTS links (
     id serial PRIMARY KEY,
     face_a integer NOT NULL REFERENCES faces (id) ON DELETE CASCADE,
     face_b integer NOT NULL REFERENCES faces (id) ON DELETE CASCADE,
     created_at timestamp NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS faces_person_idx ON faces (person_id)`,
  `CREATE INDEX IF NOT EXISTS faces_embedding_idx ON faces USING hnsw (embedding vector_cosine_ops)`,
];

let ready: Promise<void> | null = null;

/** Create the extension, tables and indexes once per process. Keeps the app free of a migration tool. */
export function ensureSchema(): Promise<void> {
  ready ??= (async () => {
    for (const statement of DDL) await sql.unsafe(statement);
  })();
  return ready;
}
