import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { storage, type Storage } from '../src/storage.js';

/**
 * MinIO stands in for R2 in tests: same S3 API, same presigned-URL mechanics,
 * no credentials and no network. Set TEST_S3_ENDPOINT to enable.
 */
export const S3_ENDPOINT = process.env.TEST_S3_ENDPOINT ?? null;
export const skipUnlessS3 = {
  skip: S3_ENDPOINT ? false : 'set TEST_S3_ENDPOINT (see README)',
};

let counter = 0;

export async function freshBucket(): Promise<Storage> {
  if (!S3_ENDPOINT) throw new Error('TEST_S3_ENDPOINT is not set');
  const bucket = `test-${process.pid}-${++counter}`;
  const env = {
    S3_ENDPOINT,
    R2_BUCKET: bucket,
    R2_ACCESS_KEY_ID: process.env.TEST_S3_KEY ?? 'minioadmin',
    R2_SECRET_ACCESS_KEY: process.env.TEST_S3_SECRET ?? 'minioadmin',
  } as NodeJS.ProcessEnv;

  const client = new S3Client({
    region: 'auto',
    endpoint: S3_ENDPOINT,
    forcePathStyle: true,
    credentials: {
      accessKeyId: env.R2_ACCESS_KEY_ID!,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY!,
    },
  });
  await client.send(new CreateBucketCommand({ Bucket: bucket }));
  return storage(env);
}

/** Uploads through a presigned URL exactly as the phone would. */
export async function putViaPresignedUrl(
  url: string,
  body: Uint8Array | string
): Promise<number> {
  const res = await fetch(url, {
    method: 'PUT',
    body,
    headers: { 'content-type': 'audio/mp4' },
  });
  return res.status;
}
