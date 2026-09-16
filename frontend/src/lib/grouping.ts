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

/** The average of several embeddings, back on the unit sphere. */
export function average(embeddings: number[][]): number[] {
  const sum = new Array(embeddings[0].length).fill(0);
  for (const embedding of embeddings) embedding.forEach((v, i) => (sum[i] += v));
  const length = Math.hypot(...sum);
  return sum.map((v) => v / length);
}

type Candidate = { personId: number; faceId: number; similarity: number };

/**
 * Who this face could be: every person among its nearest already-grouped neighbours, with the
 * closest face of theirs. Anything from the same photo or video is ignored, because two faces
 * in one picture are almost never the same person.
 *
 * Looking at the nearest handful rather than only the single nearest is what makes it possible
 * to ask how far ahead the winner is — see `decide`.
 */
async function candidates(vector: string, photoId: number): Promise<Candidate[]> {
  const rows = await sql<{ person_id: number; id: number; similarity: number }[]>`
    SELECT DISTINCT ON (person_id) person_id, id, 1 - (embedding <=> ${vector}::vector) AS similarity
      FROM (SELECT person_id, id, embedding
              FROM faces
             WHERE person_id IS NOT NULL AND photo_id <> ${photoId}
             ORDER BY embedding <=> ${vector}::vector
             LIMIT ${config.matchNeighbours}) near
     ORDER BY person_id, similarity DESC`;
  return rows
    .map((row) => ({ personId: row.person_id, faceId: row.id, similarity: Number(row.similarity) }))
    .sort((a, b) => b.similarity - a.similarity);
}

type Decision = {
  personId: number | null; // null = start a new person, or stay unassigned
  matched: Candidate | null;
  runnerUp: Candidate | null;
  reason: string;
};

/**
 * Who a face belongs to, given who it could be.
 *
 * Two ways to say yes. The first is the absolute one it always had: close enough to someone,
 * full stop. The second is relative — clearly closer to one person than to anyone else — and it
 * is the one that matters for a face the model finds hard. A blurred face out of a video scored
 * 0.39 against its own photographs, under the 0.45 bar, while the nearest other person scored
 * 0.10. On the absolute rule that face is nobody; on the relative rule it is obviously the man
 * it actually is. The relative rule needs someone to be second, so it never fires in a library
 * with only one person in it, where "ahead of everyone else" means nothing.
 */
function decide(found: Candidate[], isStrong: boolean, yaw: number | null): Decision {
  const [best = null, runnerUp = null] = found;
  const threshold = isStrong ? config.sameFace : config.attachFace;

  if (best && best.similarity >= threshold) {
    return { personId: best.personId, matched: best, runnerUp, reason: "close enough" };
  }
  if (
    best &&
    runnerUp &&
    best.similarity >= config.matchFloor &&
    best.similarity - runnerUp.similarity >= config.matchMargin
  ) {
    return { personId: best.personId, matched: best, runnerUp, reason: "far closer than anyone else" };
  }
  if (canStartPerson(isStrong, yaw)) {
    return { personId: null, matched: best, runnerUp, reason: "new person" };
  }
  return {
    personId: null,
    matched: best,
    runnerUp,
    reason: isStrong ? "too turned to start a person" : "too far",
  };
}

/** Writes a decision onto some faces, creating the person if the decision asks for a new one. */
async function apply(faceIds: number[], decision: Decision): Promise<number | null> {
  let personId = decision.personId;
  if (personId === null && decision.reason === "new person") {
    const [person] = await sql<{ id: number }[]>`INSERT INTO people DEFAULT VALUES RETURNING id`;
    personId = person.id;
  }
  await sql`
    UPDATE faces SET person_id = ${personId}, matched_face_id = ${decision.matched?.faceId ?? null},
                     match_similarity = ${decision.matched?.similarity ?? null},
                     assigned_by = ${decision.reason}
     WHERE id IN ${sql(faceIds)}`;
  return personId;
}

/**
 * Two people, one face that plainly belongs to both: they were one person all along.
 *
 * This is what unites a person built from photographs with the same person found in a video,
 * when whichever arrived first was too different to match the other directly. The new face
 * bridges them, and the bridge is recorded as a link so regrouping does not pull them apart.
 * Refused when the two already share a photo or a video frame, because that is proof they are
 * different people.
 */
async function bridge(found: Candidate[], isStrong: boolean): Promise<number | null> {
  const [best, second] = found;
  const threshold = isStrong ? config.sameFace : config.attachFace;
  if (!second || second.similarity < threshold) return null;

  // Refused if they share a picture, and refused if you have already said they are different.
  const clash = await sql<{ one: number }[]>`
    SELECT 1 AS one
      FROM faces a JOIN faces b
        ON a.photo_id = b.photo_id AND COALESCE(a.track, -1) = COALESCE(b.track, -1)
     WHERE a.person_id = ${best.personId} AND b.person_id = ${second.personId}
     UNION ALL
    SELECT 1 AS one
      FROM links l JOIN faces a ON a.id = l.face_a JOIN faces b ON b.id = l.face_b
     WHERE l.kind = 'different'
       AND ((a.person_id = ${best.personId} AND b.person_id = ${second.personId})
         OR (a.person_id = ${second.personId} AND b.person_id = ${best.personId}))
     LIMIT 1`;
  if (clash.length > 0) return null;

  await sql`INSERT INTO links (face_a, face_b) VALUES (${best.faceId}, ${second.faceId})`;
  await sql`
    UPDATE faces SET person_id = ${best.personId}, assigned_by = 'joined up by a face matching both'
     WHERE person_id = ${second.personId}`;
  await sql`DELETE FROM people WHERE id = ${second.personId}`;
  return second.personId;
}

/**
 * Give one new face a person, the moment it arrives.
 *
 * The nearest person and the score are always written down, even when nothing matched, so the
 * inspect page can show why each face landed where it did.
 */
export async function assignPerson(
  faceId: number,
  photoId: number,
  embedding: number[],
  isStrong: boolean,
  yaw: number | null,
): Promise<number | null> {
  const found = await candidates(toVector(embedding), photoId);
  const decision = decide(found, isStrong, yaw);
  const personId = await apply([faceId], decision);
  if (decision.personId !== null) await bridge(found, isStrong);
  return personId;
}

/**
 * Give a whole track one person at once.
 *
 * A track is one person's continuous appearance in a video, so its faces cannot belong to
 * different people — deciding for each of them separately would only invent ways to disagree.
 * The appearance is matched as one face, the average of the few frames kept from it, which is a
 * steadier picture of somebody than any single frame: averaging moved every appearance in the
 * test clip a little closer to the right person and no closer to a wrong one.
 */
export async function assignTrack(
  photoId: number,
  faces: { id: number; embedding: number[]; isStrong: boolean; yaw: number | null }[],
): Promise<number | null> {
  if (faces.length === 0) return null;
  const [best] = faces; // the pipeline delivers a track's faces best first
  const found = await candidates(toVector(average(faces.map((face) => face.embedding))), photoId);
  const decision = decide(found, best.isStrong, best.yaw);
  const personId = await apply(faces.map((face) => face.id), decision);
  if (decision.personId !== null) await bridge(found, best.isStrong);
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
  const links = await sql<{ face_a: number; face_b: number; kind: string }[]>`
    SELECT face_a, face_b, kind FROM links`;
  const sameLinks = links.filter((link) => link.kind !== "different");
  const apartLinks = links.filter((link) => link.kind === "different");

  const vectors = new Map(rows.map((r) => [r.id, JSON.parse(r.embedding) as number[]]));
  const strong = rows.filter((r) => r.is_strong);
  const similarity = (a: number[], b: number[]) => a.reduce((sum, v, i) => sum + v * b[i], 0);

  // Start with one cluster per strong face, then merge the closest pair while it is close enough.
  // Faces you have said are not the same person, both ways round.
  const apartFrom = new Map<number, Set<number>>();
  for (const link of apartLinks) {
    apartFrom.set(link.face_a, (apartFrom.get(link.face_a) ?? new Set()).add(link.face_b));
    apartFrom.set(link.face_b, (apartFrom.get(link.face_b) ?? new Set()).add(link.face_a));
  }

  const clusters = strong.map((face) => ({
    faces: [face.id],
    sources: new Set([sourceOf(face)]), // what may never share a group: a photo, or one track
    photos: new Set([face.photo_id]), // how many pictures a person is in, for ordering them
    blocked: new Set(apartFrom.get(face.id) ?? []), // faces this group may never take in
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
    clusters[b].blocked.forEach((face) => clusters[a].blocked.add(face));
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
    // Never put two faces of one photo, or two tracks of one video, in the same group — and
    // never undo a face you took out of a group by hand.
    const forbidden =
      [...clusters[best.b].sources].some((source) => clusters[best.a].sources.has(source)) ||
      clusters[best.b].faces.some((face) => clusters[best.a].blocked.has(face)) ||
      clusters[best.a].faces.some((face) => clusters[best.b].blocked.has(face));
    if (forbidden) {
      between.set(key(best.a, best.b), -Infinity);
      continue;
    }
    absorb(best.a, best.b);
  }

  // Your merges win over the clustering, same-photo rule included: you said they are one person.
  const clusterOf = new Map<number, number>();
  for (const index of alive) for (const faceId of clusters[index].faces) clusterOf.set(faceId, index);
  for (const link of sameLinks) {
    const a = clusterOf.get(link.face_a);
    const b = clusterOf.get(link.face_b);
    if (a === undefined || b === undefined || a === b) continue;
    absorb(a, b);
    for (const faceId of clusters[a].faces) clusterOf.set(faceId, a);
  }

  // The same relative rule the matcher uses when a face arrives, now between whole groups: a
  // group that is far closer to one other group than to any third is that group. Clustering on
  // its own leaves a hard face — the childhood photograph, an appearance shot from across a room
  // — sitting alone below the 0.45 bar, even when it is three times closer to its own person
  // than to anybody else. Without this pass, pressing "Regroup everything" would undo the very
  // matches the app made when the pictures arrived.
  const closestBetween = (a: number, b: number) => {
    let best = -Infinity;
    for (const one of clusters[a].faces) {
      for (const other of clusters[b].faces) {
        const value = similarity(vectors.get(one)!, vectors.get(other)!);
        if (value > best) best = value;
      }
    }
    return best;
  };
  const forbidden = (a: number, b: number) =>
    [...clusters[b].sources].some((source) => clusters[a].sources.has(source)) ||
    clusters[b].faces.some((face) => clusters[a].blocked.has(face)) ||
    clusters[a].faces.some((face) => clusters[b].blocked.has(face));

  for (let sweep = 0; sweep < clusters.length; sweep++) {
    let joined = false;
    for (const a of [...alive]) {
      if (!alive.has(a)) continue;
      const ranked = [...alive]
        .filter((b) => b !== a && !forbidden(a, b))
        .map((b) => ({ b, value: closestBetween(a, b) }))
        .sort((x, y) => y.value - x.value);
      const [best, runnerUp] = ranked;
      // Needs a runner-up: "closer to them than to anyone else" says nothing when there is
      // nobody else to be closer than.
      if (!best || !runnerUp) continue;
      if (best.value < config.matchFloor || best.value - runnerUp.value < config.matchMargin) continue;
      absorb(a, best.b);
      joined = true;
    }
    if (!joined) break;
  }

  // A group needs at least one face good enough to start a person, or it isn't a person.
  const canStart = new Map(rows.map((r) => [r.id, canStartPerson(r.is_strong, r.yaw)]));
  const groups = [...alive]
    .map((i) => clusters[i])
    .filter((group) => group.faces.some((id) => canStart.get(id)))
    .sort((x, y) => y.photos.size - x.photos.size);

  const personOf = new Map<number, number>();
  groups.forEach((group, index) => group.faces.forEach((id) => personOf.set(id, index)));
  const evidence = new Map<number, { face: number | null; similarity: number | null }>();

  // Faces the clustering left over join whichever group they are closest to — either because
  // they are close enough outright, or because they are far closer to that one than to any
  // other, which is the same relative rule `decide` uses when a face first arrives.
  //
  // A group is scored by its closest face, not by the average of its faces, for two reasons. It
  // is what a new face is scored against when it arrives, so pressing "Regroup everything" no
  // longer changes answers; and it is measurably better — over the test library the closest face
  // beat the average on three appearances out of five, because averaging a person's face across
  // years, lighting and half-turns blurs exactly the detail a hard face has to match.
  for (const face of rows) {
    if (personOf.has(face.id)) continue; // already placed by the clustering
    const vector = vectors.get(face.id)!;
    const ranked = groups
      .map((group, index) => {
        let best = { face: -1, value: -Infinity };
        for (const other of group.faces) {
          const value = similarity(vector, vectors.get(other)!);
          if (value > best.value) best = { face: other, value };
        }
        return { index, ...best };
      })
      .filter(
        (option) =>
          !groups[option.index].sources.has(sourceOf(face)) &&
          !groups[option.index].faces.some((other) => apartFrom.get(face.id)?.has(other)),
      )
      .sort((x, y) => y.value - x.value);
    const [best, runnerUp] = ranked;
    if (!best || best.face < 0) continue;
    const bar = face.is_strong ? config.sameFace : config.attachFace;
    const clear =
      runnerUp && best.value >= config.matchFloor && best.value - runnerUp.value >= config.matchMargin;
    if (best.value >= bar || clear) {
      personOf.set(face.id, best.index);
      evidence.set(face.id, { face: best.face, similarity: best.value });
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
