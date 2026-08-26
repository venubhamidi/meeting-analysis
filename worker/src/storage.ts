import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createReadStream, createWriteStream, statSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';

/** Presigned upload URLs are short-lived; the app re-requests on resume. */
export const UPLOAD_URL_TTL_S = 15 * 60;
/** Playback URLs are shorter still — they are the audio authorization surface (§13.2). */
export const PLAYBACK_URL_TTL_S = 5 * 60;

export type Storage = {
  bucket: string;
  presignPut(key: string, contentType: string): Promise<string>;
  presignGet(key: string): Promise<string>;
  head(key: string): Promise<{ size: number } | null>;
  /** Streams an object to a local path. Used by the pipeline, never by the app. */
  download(key: string, destPath: string): Promise<void>;
  upload(key: string, srcPath: string, contentType: string): Promise<void>;
  delete(key: string): Promise<void>;
};

export function segmentKey(meetingId: string, seq: number): string {
  return `meetings/${meetingId}/segments/${String(seq).padStart(4, '0')}.m4a`;
}

/** The concatenated original, kept forever as ground truth (§4.1). */
export function meetingAudioKey(meetingId: string): string {
  return `meetings/${meetingId}/audio.m4a`;
}

export function storage(env = process.env): Storage {
  const bucket = required(env, 'R2_BUCKET');
  const client = new S3Client({
    region: 'auto',
    endpoint:
      env.S3_ENDPOINT ??
      `https://${required(env, 'R2_ACCOUNT_ID')}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: required(env, 'R2_ACCESS_KEY_ID'),
      secretAccessKey: required(env, 'R2_SECRET_ACCESS_KEY'),
    },
    // MinIO in tests serves path-style URLs; R2 accepts them too.
    forcePathStyle: env.S3_ENDPOINT != null,
  });

  return {
    bucket,
    presignPut: (key, contentType) =>
      getSignedUrl(
        client,
        new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType }),
        { expiresIn: UPLOAD_URL_TTL_S }
      ),
    presignGet: (key) =>
      getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), {
        expiresIn: PLAYBACK_URL_TTL_S,
      }),
    async head(key) {
      try {
        const r = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return { size: r.ContentLength ?? 0 };
      } catch (e: any) {
        if (e?.$metadata?.httpStatusCode === 404 || e?.name === 'NotFound') return null;
        throw e;
      }
    },
    async download(key, destPath) {
      const r = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (!r.Body) throw new Error(`empty body for ${key}`);
      await pipeline(r.Body as Readable, createWriteStream(destPath));
    },
    async upload(key, srcPath, contentType) {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: createReadStream(srcPath),
          ContentLength: statSync(srcPath).size,
          ContentType: contentType,
        })
      );
    },
    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
  };
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}
