import { sql } from "@/db";

import { config } from "./config";

/** pgvector reads and writes vectors as "[1,2,3]". */
export const toVector = (embedding: number[]) => `[${embedding.join(",")}]`;

type FaceRow = { id: number; photo_id: number; is_strong: boolean; embedding: string };

/**
 * Give one new face a person, the moment it arrives: find its nearest neighbour among the
 * faces already grouped and join that person if they are close enough. Faces in the same
 * photo are ignored, because two faces in one photo are almost never the same person.
 * A weak face can join someone but never starts a new person.
 *
 * The nearest face and its score are always written down, even when nothing matched, so the
 * inspect page can show why each face landed where it did.
 */
export async function assignPerson(
  faceId: number,
  photoId: number,
  embedding: number[],
  isStrong: boolean,
): Promise<number | null> {
  const vector = toVector(embedding);
  const [nearest] = await sql<{ id: number; person_id: number; similarity: number }[]>`
    SELECT id, person_id, 1 - (embedding <=> ${vector}::vector) AS similarity
      FROM faces
     WHERE person_id IS NOT NULL AND photo_id <> ${photoId} AND id <> ${faceId}
     ORDER BY embedding <=> ${vector}::vector
     LIMIT 1`;

  const similarity = nearest ? Number(nearest.similarity) : null;
  const threshold = isStrong ? config.sameFace : config.attachFace;

  if (nearest && similarity !== null && similarity >= threshold) {
    await sql`
      UPDATE faces SET person_id = ${nearest.person_id}, matched_face_id = ${nearest.id},
                       match_similarity = ${similarity}, assigned_by = 'arrival'
       WHERE id = ${faceId}`;
    return nearest.person_id;
  }

  if (!isStrong) {
    await sql`
      UPDATE faces SET matched_face_id = ${nearest?.id ?? null}, match_similarity = ${similarity},
                       assigned_by = 'too far'
       WHERE id = ${faceId}`;
    return null;
  }

  const [person] = await sql<{ id: number }[]>`INSERT INTO people DEFAULT VALUES RETURNING id`;
  await sql`
    UPDATE faces SET person_id = ${person.id}, matched_face_id = ${nearest?.id ?? null},
                     match_similarity = ${similarity}, assigned_by = 'new person'
     WHERE id = ${faceId}`;
  return person.id;
}

/**
 * Group the whole library again from scratch: average-linkage clustering over the strong
 * faces, then weak faces join whichever group they are closest to. Slower than assigning on
 * arrival, but it fixes groups that drifted apart as more photos arrived.
 */
export async function regroupLibrary() {
  const rows = await sql<FaceRow[]>`
    SELECT id, photo_id, is_strong, embedding::text AS embedding FROM faces ORDER BY id`;
  if (rows.length === 0) return { people: 0, faces: 0, unassigned: 0 };

  const vectors = new Map(rows.map((r) => [r.id, JSON.parse(r.embedding) as number[]]));
  const strong = rows.filter((r) => r.is_strong);
  const similarity = (a: number[], b: number[]) => a.reduce((sum, v, i) => sum + v * b[i], 0);

  // Start with one cluster per strong face, then merge the closest pair while it is close enough.
  const clusters = strong.map((face) => ({ faces: [face.id], photos: new Set([face.photo_id]) }));
  const between = new Map<string, number>();
  const key = (a: number, b: number) => `${Math.min(a, b)}:${Math.max(a, b)}`;
  for (let i = 0; i < clusters.length; i++) {
    for (let j = i + 1; j < clusters.length; j++) {
      between.set(key(i, j), similarity(vectors.get(clusters[i].faces[0])!, vectors.get(clusters[j].faces[0])!));
    }
  }

  const alive = new Set(clusters.map((_, i) => i));
  const size = new Map([...alive].map((i) => [i, 1]));
  while (true) {
    let best = { value: -Infinity, a: -1, b: -1 };
    for (const a of alive) {
      for (const b of alive) {
        if (b <= a) continue;
        const value = between.get(key(a, b)) ?? -Infinity;
        if (value > best.value) best = { value, a, b };
      }
    }
    if (best.a < 0 || best.value < config.sameFace) break;
    const [a, b] = [best.a, best.b];
    // Never put two faces from one photo in the same group.
    if ([...clusters[b].photos].some((photo) => clusters[a].photos.has(photo))) {
      between.set(key(a, b), -Infinity);
      continue;
    }
    clusters[a].faces.push(...clusters[b].faces);
    clusters[b].photos.forEach((photo) => clusters[a].photos.add(photo));
    alive.delete(b);
    const sizeA = size.get(a)!;
    const sizeB = size.get(b)!;
    for (const c of alive) {
      if (c === a) continue;
      const merged =
        ((between.get(key(a, c)) ?? 0) * sizeA + (between.get(key(b, c)) ?? 0) * sizeB) / (sizeA + sizeB);
      between.set(key(a, c), merged); // average linkage: the mean similarity between members
    }
    size.set(a, sizeA + sizeB);
  }

  const groups = [...alive].map((i) => clusters[i]).sort((x, y) => y.photos.size - x.photos.size);

  // Centres of each group, for the weak faces.
  const centres = groups.map((group) => {
    const sum = new Array(512).fill(0);
    for (const id of group.faces) vectors.get(id)!.forEach((v, i) => (sum[i] += v));
    const length = Math.hypot(...sum);
    return sum.map((v) => v / length);
  });

  const personOf = new Map<number, number>();
  groups.forEach((group, index) => group.faces.forEach((id) => personOf.set(id, index)));
  const evidence = new Map<number, { face: number | null; similarity: number | null }>();

  for (const face of rows) {
    if (face.is_strong) continue;
    const vector = vectors.get(face.id)!;
    let best = { index: -1, value: -Infinity };
    centres.forEach((centre, index) => {
      const value = similarity(vector, centre);
      if (value > best.value && !groups[index].photos.has(face.photo_id)) best = { index, value };
    });
    if (best.index >= 0 && best.value >= config.attachFace) {
      personOf.set(face.id, best.index);
      evidence.set(face.id, { face: null, similarity: best.value }); // matched the group's average face
    }
  }

  // For every grouped face, note its closest companion inside the group: that is the link that holds it there.
  for (const [faceId, groupIndex] of personOf) {
    if (evidence.has(faceId)) continue;
    let best = { face: null as number | null, similarity: -Infinity };
    for (const other of groups[groupIndex].faces) {
      if (other === faceId) continue;
      const value = similarity(vectors.get(faceId)!, vectors.get(other)!);
      if (value > best.similarity) best = { face: other, similarity: value };
    }
    evidence.set(faceId, { face: best.face, similarity: Number.isFinite(best.similarity) ? best.similarity : null });
  }

  // Replace the people table with the new grouping, numbered so the biggest group comes first.
  await sql.begin(async (tx) => {
    await tx`UPDATE faces SET person_id = NULL, matched_face_id = NULL, match_similarity = NULL, assigned_by = 'too far'`;
    await tx`DELETE FROM people`;
    const ids: number[] = [];
    for (let i = 0; i < groups.length; i++) {
      const [person] = await tx<{ id: number }[]>`INSERT INTO people DEFAULT VALUES RETURNING id`;
      ids.push(person.id);
    }
    for (const [faceId, groupIndex] of personOf) {
      const why = evidence.get(faceId);
      await tx`
        UPDATE faces SET person_id = ${ids[groupIndex]}, matched_face_id = ${why?.face ?? null},
                         match_similarity = ${why?.similarity ?? null}, assigned_by = 'regroup'
         WHERE id = ${faceId}`;
    }
  });

  return { people: groups.length, faces: rows.length, unassigned: rows.length - personOf.size };
}
