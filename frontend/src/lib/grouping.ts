import { sql } from "@/db";

import { config } from "./config";

/** pgvector reads and writes vectors as "[1,2,3]". */
export const toVector = (embedding: number[]) => `[${embedding.join(",")}]`;

type FaceRow = {
  id: number;
  photo_id: number;
  track: number | null;
  quality: number;
  is_strong: boolean;
  yaw: number | null;
  embedding: string;
};

/**
 * What two faces have to come from before they are forbidden to be the same person.
 *
 * Two faces in one photo are almost never one person, and the same holds for two faces in one
 * frame of a video — which is what two tracks of one video mean. Faces inside a single track are
 * the same person by construction, so the track has to be part of the key: without it every face
 * of a video would be forbidden from joining the rest of its own appearance.
 */
const sourceOf = (face: { photo_id: number; track: number | null }) =>
  `${face.photo_id}:${face.track ?? ""}`;

/**
 * Joining a person is easy, starting one is not. A face that is small, blurry or turned away can
 * join someone it clearly matches, but may never become a person of its own: otherwise one
 * profile shot of a man you already have becomes a second person.
 */
export function canStartPerson(isStrong: boolean, yaw: number | null): boolean {
  return isStrong && Number(yaw ?? 1) <= config.createMaxYaw;
}

/** The closest already-grouped face, ignoring everything from the same photo or video. */
async function nearestGrouped(vector: string, photoId: number, faceId: number) {
  const [nearest] = await sql<{ id: number; person_id: number; similarity: number }[]>`
    SELECT id, person_id, 1 - (embedding <=> ${vector}::vector) AS similarity
      FROM faces
     WHERE person_id IS NOT NULL AND photo_id <> ${photoId} AND id <> ${faceId}
     ORDER BY embedding <=> ${vector}::vector
     LIMIT 1`;
  return nearest ?? null;
}

/**
 * Give one new face a person, the moment it arrives: find its nearest neighbour among the
 * faces already grouped and join that person if they are close enough. Faces in the same
 * photo are ignored, because two faces in one photo are almost never the same person.
 *
 * The nearest face and its score are always written down, even when nothing matched, so the
 * inspect page can show why each face landed where it did.
 */
export async function assignPerson(
  faceId: number,
  photoId: number,
  embedding: number[],
  isStrong: boolean,
  yaw: number | null,
): Promise<number | null> {
  const vector = toVector(embedding);
  const nearest = await nearestGrouped(vector, photoId, faceId);

  const similarity = nearest ? Number(nearest.similarity) : null;
  const threshold = isStrong ? config.sameFace : config.attachFace;

  if (nearest && similarity !== null && similarity >= threshold) {
    await sql`
      UPDATE faces SET person_id = ${nearest.person_id}, matched_face_id = ${nearest.id},
                       match_similarity = ${similarity}, assigned_by = 'arrival'
       WHERE id = ${faceId}`;
    return nearest.person_id;
  }

  if (!canStartPerson(isStrong, yaw)) {
    await sql`
      UPDATE faces SET matched_face_id = ${nearest?.id ?? null}, match_similarity = ${similarity},
                       assigned_by = ${isStrong ? "too turned to start a person" : "too far"}
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
 * Give a whole track one person at once.
 *
 * A track is one person's continuous appearance in a video, so its faces cannot belong to
 * different people — deciding for each of them separately would only invent ways to disagree.
 * The track's best face does the matching and the rest follow it, which also means a turned or
 * blurred face inside the track never has to clear the bar on its own.
 */
export async function assignTrack(
  photoId: number,
  faces: { id: number; embedding: number[]; isStrong: boolean; yaw: number | null }[],
): Promise<number | null> {
  if (faces.length === 0) return null;
  const [best, ...rest] = faces; // the pipeline delivers a track's faces best first
  const vector = toVector(best.embedding);
  const nearest = await nearestGrouped(vector, photoId, best.id);
  const similarity = nearest ? Number(nearest.similarity) : null;
  const threshold = best.isStrong ? config.sameFace : config.attachFace;
  const ids = [best.id, ...rest.map((face) => face.id)];

  let personId: number | null = null;
  let assignedBy: string;
  if (nearest && similarity !== null && similarity >= threshold) {
    personId = nearest.person_id;
    assignedBy = "track joined a person";
  } else if (canStartPerson(best.isStrong, best.yaw)) {
    const [person] = await sql<{ id: number }[]>`INSERT INTO people DEFAULT VALUES RETURNING id`;
    personId = person.id;
    assignedBy = "track started a person";
  } else {
    assignedBy = best.isStrong ? "too turned to start a person" : "too far";
  }

  await sql`
    UPDATE faces SET person_id = ${personId}, matched_face_id = ${nearest?.id ?? null},
                     match_similarity = ${similarity}, assigned_by = ${assignedBy}
     WHERE id IN ${sql(ids)}`;
  return personId;
}

/**
 * Group the whole library again from scratch: average-linkage clustering over the strong faces,
 * then weak faces join whichever group they are closest to. Slower than assigning on arrival, but
 * it repairs groups that drifted apart. Merges you made by hand are applied first, and a group
 * that holds no face good enough to start a person is dissolved back into unassigned faces.
 */
export async function regroupLibrary() {
  const rows = await sql<FaceRow[]>`
    SELECT id, photo_id, track, quality, is_strong, yaw, embedding::text AS embedding
      FROM faces ORDER BY id`;
  if (rows.length === 0) return { people: 0, faces: 0, unassigned: 0 };
  const links = await sql<{ face_a: number; face_b: number }[]>`SELECT face_a, face_b FROM links`;

  const vectors = new Map(rows.map((r) => [r.id, JSON.parse(r.embedding) as number[]]));
  const strong = rows.filter((r) => r.is_strong);
  const similarity = (a: number[], b: number[]) => a.reduce((sum, v, i) => sum + v * b[i], 0);

  // Start with one cluster per strong face, then merge the closest pair while it is close enough.
  const clusters = strong.map((face) => ({
    faces: [face.id],
    sources: new Set([sourceOf(face)]), // what may never share a group: a photo, or one track
    photos: new Set([face.photo_id]), // how many pictures a person is in, for ordering them
  }));
  const between = new Map<string, number>();
  const key = (a: number, b: number) => `${Math.min(a, b)}:${Math.max(a, b)}`;
  for (let i = 0; i < clusters.length; i++) {
    for (let j = i + 1; j < clusters.length; j++) {
      between.set(key(i, j), similarity(vectors.get(clusters[i].faces[0])!, vectors.get(clusters[j].faces[0])!));
    }
  }

  const alive = new Set(clusters.map((_, i) => i));
  const size = new Map([...alive].map((i) => [i, 1]));

  const absorb = (a: number, b: number) => {
    clusters[a].faces.push(...clusters[b].faces);
    clusters[b].sources.forEach((source) => clusters[a].sources.add(source));
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
  };

  // A track's faces are one person before the clustering starts: they came from one unbroken
  // appearance. Joining them first also gives the clustering a better first impression of that
  // person than any single frame of them could.
  const firstOfTrack = new Map<string, number>();
  for (let i = 0; i < clusters.length; i++) {
    const source = [...clusters[i].sources][0];
    if (!source.endsWith(":")) {
      const first = firstOfTrack.get(source);
      if (first === undefined) firstOfTrack.set(source, i);
      else absorb(first, i);
    }
  }

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
    // Never put two faces of one photo, or two tracks of one video, in the same group.
    if ([...clusters[best.b].sources].some((source) => clusters[best.a].sources.has(source))) {
      between.set(key(best.a, best.b), -Infinity);
      continue;
    }
    absorb(best.a, best.b);
  }

  // Your merges win over the clustering, same-photo rule included: you said they are one person.
  const clusterOf = new Map<number, number>();
  for (const index of alive) for (const faceId of clusters[index].faces) clusterOf.set(faceId, index);
  for (const link of links) {
    const a = clusterOf.get(link.face_a);
    const b = clusterOf.get(link.face_b);
    if (a === undefined || b === undefined || a === b) continue;
    absorb(a, b);
    for (const faceId of clusters[a].faces) clusterOf.set(faceId, a);
  }

  // A group needs at least one face good enough to start a person, or it isn't a person.
  const canStart = new Map(rows.map((r) => [r.id, canStartPerson(r.is_strong, r.yaw)]));
  const groups = [...alive]
    .map((i) => clusters[i])
    .filter((group) => group.faces.some((id) => canStart.get(id)))
    .sort((x, y) => y.photos.size - x.photos.size);

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
    if (personOf.has(face.id)) continue; // already placed by the clustering
    const vector = vectors.get(face.id)!;
    let best = { index: -1, value: -Infinity };
    centres.forEach((centre, index) => {
      const value = similarity(vector, centre);
      if (value > best.value && !groups[index].sources.has(sourceOf(face))) best = { index, value };
    });
    const bar = face.is_strong ? config.sameFace : config.attachFace;
    if (best.index >= 0 && best.value >= bar) {
      personOf.set(face.id, best.index);
      evidence.set(face.id, { face: null, similarity: best.value }); // matched the group's average face
    }
  }

  // Every face of a track follows its track. The clustering already keeps a track's strong faces
  // together; this catches the weak ones, which are judged one by one and could otherwise drift
  // off to another person or to nobody — even though they are frames of the very same appearance.
  const byTrack = new Map<string, FaceRow[]>();
  for (const face of rows) {
    if (face.track === null) continue;
    byTrack.set(sourceOf(face), [...(byTrack.get(sourceOf(face)) ?? []), face]);
  }
  for (const track of byTrack.values()) {
    const ranked = [...track].sort((x, y) => y.quality - x.quality);
    const leader = ranked.find((face) => personOf.has(face.id));
    if (!leader) continue;
    for (const face of track) {
      if (face.id === leader.id || personOf.get(face.id) === personOf.get(leader.id)) continue;
      personOf.set(face.id, personOf.get(leader.id)!);
      evidence.set(face.id, {
        face: leader.id,
        similarity: similarity(vectors.get(face.id)!, vectors.get(leader.id)!),
      });
    }
  }

  // For every grouped face, note its closest companion inside the group: the link that holds it there.
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
