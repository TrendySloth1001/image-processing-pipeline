import { config } from "./config";

/**
 * Hand one photo or video to the face pipeline. It answers straight away with a job id and later
 * posts the result to our webhook, retrying until we acknowledge with a 2xx.
 *
 * Which field the object key goes in is the whole difference between the two: `image` comes back
 * as faces, `video` as tracks.
 */
export async function submitJob(key: string, photoId: number, kind: "photo" | "video" = "photo") {
  const media = kind === "video" ? { video: { key } } : { image: { key } };
  const response = await fetch(`${config.pipelineUrl}/v1/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...media,
      callback_url: config.callbackUrl,
      metadata: { photoId }, // comes back untouched in the webhook
    }),
  });
  if (!response.ok) {
    throw new Error(`pipeline refused the job (${response.status}): ${await response.text()}`);
  }
  const accepted = (await response.json()) as { job_id: string };
  return accepted.job_id;
}
