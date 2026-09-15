import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

import { config } from "./config";

export const s3 = new S3Client({
  endpoint: config.s3.endpoint,
  region: config.s3.region,
  forcePathStyle: true, // MinIO serves buckets as a path, not a subdomain
  credentials: { accessKeyId: config.s3.accessKey, secretAccessKey: config.s3.secretKey },
});

export async function putObject(key: string, body: Buffer, contentType: string) {
  await s3.send(
    new PutObjectCommand({ Bucket: config.s3.bucket, Key: key, Body: body, ContentType: contentType }),
  );
  return key;
}

/** Streams an object back out, so photos can be shown without making the bucket public. */
export async function getObjectStream(key: string) {
  const object = await s3.send(new GetObjectCommand({ Bucket: config.s3.bucket, Key: key }));
  return {
    body: object.Body!.transformToWebStream(),
    contentType: object.ContentType ?? "application/octet-stream",
  };
}

/** Every key under a prefix, following pagination. */
export async function listKeys(prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const page = await s3.send(
      new ListObjectsV2Command({ Bucket: config.s3.bucket, Prefix: prefix, ContinuationToken: token }),
    );
    for (const object of page.Contents ?? []) if (object.Key) keys.push(object.Key);
    token = page.NextContinuationToken;
  } while (token);
  return keys;
}

export async function deleteObjects(keys: string[]) {
  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000);
    if (batch.length === 0) continue;
    await s3.send(
      new DeleteObjectsCommand({
        Bucket: config.s3.bucket,
        Delete: { Objects: batch.map((Key) => ({ Key })) },
      }),
    );
  }
  return keys.length;
}
