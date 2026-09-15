import { config } from "./config";

/**
 * Hand one photo to the face pipeline. It answers straight away with a job id and later
 * posts the faces to our webhook, retrying until we acknowledge with a 2xx.
 */
export async function submitJob(key: string, photoId: number): Promise<string> {
  const response = await fetch(`${config.pipelineUrl}/v1/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      image: { key },
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
