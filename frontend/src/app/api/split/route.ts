import { ensureSchema, sql } from "@/db";
import { goTo } from "@/lib/redirect";

export const runtime = "nodejs";

/**
 * "That one isn't them." Takes a picture out of a person and gives it a person of its own, then
 * records the decision as a `different` link so regrouping never puts them back together.
 *
 * This is the other half of merging, and what makes it safe for the matcher to be bold: a face
 * that joined someone on thin evidence can be taken back out, once, by hand.
 *
 * An appearance in a video moves as a whole. Its faces are frames of one person walking across
 * one clip, so splitting one frame out of it would be splitting a person from themselves.
 */
export async function POST(request: Request) {
  await ensureSchema();
  const form = await request.formData();
  const faceId = Number(form.get("face"));
  const from = Number(form.get("from"));
  if (!faceId || !from) return goTo(`/people/${from || ""}`);

  const [face] = await sql<{ photo_id: number; track: number | null }[]>`
    SELECT photo_id, track FROM faces WHERE id = ${faceId} AND person_id = ${from}`;
  if (!face) return goTo(`/people/${from}`);

  const moving = await sql<{ id: number }[]>`
    SELECT id FROM faces
     WHERE person_id = ${from} AND photo_id = ${face.photo_id}
       AND COALESCE(track, -1) = ${face.track ?? -1}`;

  const staying = await sql<{ id: number }[]>`
    SELECT id FROM faces
     WHERE person_id = ${from} AND id NOT IN ${sql(moving.map((row) => row.id))}
     ORDER BY quality DESC LIMIT 1`;
  if (staying.length === 0) {
    const notice = "That is the only picture this person has, so there is nothing to take it out of.";
    return goTo(`/people/${from}`, notice);
  }

  const [person] = await sql<{ id: number }[]>`INSERT INTO people DEFAULT VALUES RETURNING id`;
  await sql`
    UPDATE faces SET person_id = ${person.id}, matched_face_id = NULL, match_similarity = NULL,
                     assigned_by = 'taken out by you'
     WHERE id IN ${sql(moving.map((row) => row.id))}`;
  await sql`
    INSERT INTO links (face_a, face_b, kind) VALUES (${moving[0].id}, ${staying[0].id}, 'different')`;

  const notice = `Moved ${moving.length} face${moving.length === 1 ? "" : "s"} out to person ${person.id}. Regrouping will keep them apart.`;
  return goTo(`/people/${from}`, notice);
}
