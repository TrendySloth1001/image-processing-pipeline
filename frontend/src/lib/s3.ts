import type { Readable } from "node:stream";

import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";

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

/**
 * Sends a stream to storage without ever holding it whole.
 *
 * A video is not a photo. Reading one into a Buffer to hand it over costs its whole size in
 * memory several times at once — once for the request body, once for the array buffer, once for
 * the copy — which is how a phone video took this process past the container's memory limit and
 * had it killed. `Upload` cuts the stream into parts, sends them, and forgets them, so the cost
 * is a few parts at a time whatever the file weighs.
 */
export async function putStream(key: string, body: Readable, contentType: string) {
  const upload = new Upload({
    client: s3,
    params: { Bucket: config.s3.bucket, Key: key, Body: body, ContentType: contentType },
    partSize: 8 * 1024 * 1024,
    queueSize: 2, // parts in flight: this many times partSize is the most it holds
  });
  await upload.done();
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

/**
 * Part of an object, for a browser that is seeking inside a video.
 *
 * The Range header is passed straight through to storage, which answers with just those bytes,
 * so scrubbing a long video never pulls the whole file through this process.
 */
export async function getObjectRange(key: string, range?: string | null) {
  const object = await s3.send(
    new GetObjectCommand({ Bucket: config.s3.bucket, Key: key, Range: range ?? undefined }),
  );
  return {
    body: object.Body!.transformToWebStream(),
    contentType: object.ContentType ?? "application/octet-stream",
    contentLength: object.ContentLength ?? null,
    contentRange: object.ContentRange ?? null,
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
