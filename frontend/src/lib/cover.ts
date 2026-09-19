import { sql } from "@/db";

/**
 * Which of a person's faces to show as their picture.
 *
 * It used to be whichever scored highest on `quality`, which the pipeline computes as detector
 * confidence times size times how straight the head is. That is a fine measure of *usable* and a
 * poor measure of *recognisable*: it put the back of someone's head, a profile, a hand across a
 * mouth and a face half out of frame on the front page, because none of those things are what it
 * measures.
 *
 * Six things are, and all six come from what is stored, so no media has to be processed again:
 *
 * - **Sharp.** Measured against the sharpest face this person has, so it asks "is this the
 *   cleanest picture of them" rather than comparing a video grab with a photograph. This is the
 *   term that does the real work, and the one that was missing: without it the score picks the
 *   most *typical* face, and in a library of video most of anybody's faces are mid-motion.
 * - **Looks like the rest of them.** The average similarity between this face and the person's
 *   other faces, at half weight. It rejects the outliers — a hand across a mouth, the back of a
 *   head, a face grouped here by mistake — without being allowed to decide on its own.
 * - **Facing the camera**, from the yaw the pipeline measured.
 * - **The detector was sure**, which sinks the half-guesses.
 * - **Big enough to see.** In real pixels, not the pipeline's saturating version, so a 300px
 *   face beats a 60px one instead of tying with it.
 * - **Not cut off by the frame**, from how far the box sits from the picture's edges. A face
 *   sliced by the edge of a photo is never the right picture of somebody.
 *
 * Multiplied rather than added, so being bad at any one of them is disqualifying on its own.
 *
 * Both fragments expect the faces table aliased `f` and the photos table aliased `pic`.
 */
export const coverScore = sql`
  (
    -- sharpness, against the sharpest this person has: the one term that separates a *clean*
    -- picture from a merely typical one, and the reason this is not just the medoid.
    COALESCE(f.blur, 0) / NULLIF((SELECT GREATEST(MAX(other.blur), 1)
                                    FROM faces other WHERE other.person_id = f.person_id), 0)
    -- ...tempered by how much it looks like the rest of them, which rejects the outliers: a hand
    -- across a mouth, the back of a head, a face that was grouped here by mistake. Softened to a
    -- half-weight, because on its own it picks the most ordinary frame rather than the best one.
    * (0.5 + 0.5 * COALESCE((SELECT AVG(1 - (f.embedding <=> other.embedding))
                               FROM faces other
                              WHERE other.person_id = f.person_id AND other.id <> f.id), 0.6))
    -- cubed, because yaw runs 0 to about 0.3 in practice and a plain (1 - yaw) barely tells a
    -- straight-on face from a three-quarter one. This makes looking at the camera count.
    * POWER(1 - LEAST(GREATEST(COALESCE(f.yaw, 0.5), 0), 1), 3)
    * f.det_score
    * LEAST(1.0, LEAST((f.bbox->>2)::float - (f.bbox->>0)::float,
                       (f.bbox->>3)::float - (f.bbox->>1)::float) / 140.0)
    * (0.3 + 0.7 * LEAST(1.0, GREATEST(0.0,
        LEAST((f.bbox->>0)::float,
              (f.bbox->>1)::float,
              COALESCE(f.still_width, pic.width, 4000) - (f.bbox->>2)::float,
              COALESCE(f.still_height, pic.height, 4000) - (f.bbox->>3)::float)
      ) / GREATEST(1.0, 0.25 * LEAST((f.bbox->>2)::float - (f.bbox->>0)::float,
                                     (f.bbox->>3)::float - (f.bbox->>1)::float))))
  )`;

/** Everything the app needs to draw one face, as `FacePicture` expects it. */
export const coverFields = sql`
  json_build_object('face_id', f.id, 'photo_id', f.photo_id, 'key', pic.key, 'bbox', f.bbox,
                    'width', pic.width, 'height', pic.height, 'still_key', f.still_key,
                    'still_width', f.still_width, 'still_height', f.still_height)`;
