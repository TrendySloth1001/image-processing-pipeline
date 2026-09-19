import { ensureSchema, sql } from "@/db";
import { goTo } from "@/lib/redirect";

export const runtime = "nodejs";

/**
 * "These two people are the same person." Moves every face across, then records the decision as a
 * link between their best faces so the next regroup keeps them together instead of splitting them
 * again. That is the honest fix for a profile shot the model can't match to its frontal photos.
 */
export async function POST(request: Request) {
  await ensureSchema();
  const form = await request.formData();
  const from = Number(form.get("from"));
  const into = Number(form.get("into"));

  if (!from || !into || from === into) {
    return goTo(`/people/${from || into || ""}`);
  }

  const [a] = await sql<{ id: number }[]>`
    SELECT id FROM faces WHERE person_id = ${from} ORDER BY quality DESC LIMIT 1`;
  const [b] = await sql<{ id: number }[]>`
    SELECT id FROM faces WHERE person_id = ${into} ORDER BY quality DESC LIMIT 1`;
  if (a && b) {
    await sql`INSERT INTO links (face_a, face_b) VALUES (${a.id}, ${b.id})`;
  }

  const moved = await sql`
    UPDATE faces SET person_id = ${into}, matched_face_id = ${b?.id ?? null}, assigned_by = 'merged by you'
     WHERE person_id = ${from}`;
  await sql`DELETE FROM people WHERE id = ${from}`;

  const notice = `Merged person ${from} into person ${into}: ${moved.count} faces moved. Regrouping will keep them together.`;
  return goTo(`/people/${into}`, notice);
}
