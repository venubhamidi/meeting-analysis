import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  segmentUploaded,
  uploadComplete,
  uploadInit,
} from '../src/api/recordings.js';
import type { Job } from '../src/jobs/queue.js';
import { freshDb, MEETING } from './harness.js';
import { freshBucket, putViaPresignedUrl, skipUnlessS3 } from './storage.js';

const CREATED = '2026-08-26T09:00:00.000Z';
const segs = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ seq: i, sizeBytes: 480_000, durationMs: 60_000 }));

/** Runs a whole recording through init -> PUT -> confirm -> complete. */
async function uploadAll(db: any, store: any, count: number) {
  const init = await uploadInit(db, store, 'u1', {
    meetingId: MEETING,
    createdAt: CREATED,
    segments: segs(count),
  });
  for (const s of init.segments) {
    assert.equal(await putViaPresignedUrl(s.url, `audio-${s.seq}`), 200);
    const r = await segmentUploaded(db, store, MEETING, s.seq);
    assert.ok(r.ok, `segment ${s.seq} not confirmed`);
  }
  return init;
}

test('upload-init returns one presigned URL per segment', skipUnlessS3, async () => {
  const db = await freshDb();
  const store = await freshBucket();

  const init = await uploadInit(db, store, 'u1', {
    meetingId: MEETING,
    createdAt: CREATED,
    segments: segs(3),
  });

  assert.equal(init.segments.length, 3);
  assert.deepEqual(init.segments.map((s) => s.seq), [0, 1, 2]);
  assert.match(init.segments[0].key, /^meetings\/.*\/segments\/0000\.m4a$/);
  assert.ok(init.segments[0].url.includes('X-Amz-Signature'));
  await db.close();
});

test('a presigned URL actually uploads, and nothing else does', skipUnlessS3, async () => {
  const db = await freshDb();
  const store = await freshBucket();
  const init = await uploadInit(db, store, 'u1', {
    meetingId: MEETING,
    createdAt: CREATED,
    segments: segs(1),
  });

  assert.equal(await putViaPresignedUrl(init.segments[0].url, 'audio bytes'), 200);
  assert.deepEqual(await store.head(init.segments[0].key), { size: 11 });

  // The same URL with its signature replaced must be rejected.
  const tampered = init.segments[0].url.replace(
    /X-Amz-Signature=[0-9a-f]+/,
    `X-Amz-Signature=${'0'.repeat(64)}`
  );
  assert.notEqual(tampered, init.segments[0].url);
  assert.equal(await putViaPresignedUrl(tampered, 'evil'), 403);
  await db.close();
});

test('invariant 2: a resumed init only re-issues what is still missing', skipUnlessS3, async () => {
  const db = await freshDb();
  const store = await freshBucket();
  const first = await uploadInit(db, store, 'u1', {
    meetingId: MEETING,
    createdAt: CREATED,
    segments: segs(5),
  });

  // Two segments land, then connectivity drops.
  for (const s of first.segments.slice(0, 2)) {
    await putViaPresignedUrl(s.url, 'audio');
    await segmentUploaded(db, store, MEETING, s.seq);
  }

  const resumed = await uploadInit(db, store, 'u1', {
    meetingId: MEETING,
    createdAt: CREATED,
    segments: segs(5),
  });

  assert.deepEqual(resumed.segments.map((s) => s.seq), [2, 3, 4]);
  await db.close();
});

test('a segment is not marked uploaded unless it is really in storage', skipUnlessS3, async () => {
  const db = await freshDb();
  const store = await freshBucket();
  await uploadInit(db, store, 'u1', {
    meetingId: MEETING,
    createdAt: CREATED,
    segments: segs(1),
  });

  // The client claims success without ever having uploaded.
  const result = await segmentUploaded(db, store, MEETING, 0);
  assert.deepEqual(result, { ok: false, reason: 'object not found in storage' });

  const { rows } = await db.query(
    `SELECT uploaded_at FROM meeting_segments WHERE meeting_id = $1`,
    [MEETING]
  );
  assert.equal(rows[0].uploaded_at, null);
  await db.close();
});

test('an empty object is rejected rather than transcribed as silence', skipUnlessS3, async () => {
  const db = await freshDb();
  const store = await freshBucket();
  const init = await uploadInit(db, store, 'u1', {
    meetingId: MEETING,
    createdAt: CREATED,
    segments: segs(1),
  });
  await putViaPresignedUrl(init.segments[0].url, '');

  const result = await segmentUploaded(db, store, MEETING, 0);
  assert.deepEqual(result, { ok: false, reason: 'object is empty' });
  await db.close();
});

test('confirmation records the true size, not the size the client claimed', skipUnlessS3, async () => {
  const db = await freshDb();
  const store = await freshBucket();
  const init = await uploadInit(db, store, 'u1', {
    meetingId: MEETING,
    createdAt: CREATED,
    segments: [{ seq: 0, sizeBytes: 999_999, durationMs: 60_000 }],
  });
  await putViaPresignedUrl(init.segments[0].url, 'short');

  const result = await segmentUploaded(db, store, MEETING, 0);
  assert.deepEqual(result, { ok: true, sizeBytes: 5 });
  await db.close();
});

test('a partial recording is never handed to transcription', skipUnlessS3, async () => {
  const db = await freshDb();
  const store = await freshBucket();
  const init = await uploadInit(db, store, 'u1', {
    meetingId: MEETING,
    createdAt: CREATED,
    segments: segs(3),
  });
  await putViaPresignedUrl(init.segments[0].url, 'audio');
  await segmentUploaded(db, store, MEETING, 0);

  const result = await uploadComplete(db, MEETING, 3, 180);
  assert.deepEqual(result, { status: 'incomplete', missing: [1, 2] });

  const { rows } = await db.query<Job>(`SELECT * FROM jobs`);
  assert.equal(rows.length, 0, 'transcription was enqueued for a partial recording');
  await db.close();
});

test('a complete upload enqueues transcription exactly once', skipUnlessS3, async () => {
  const db = await freshDb();
  const store = await freshBucket();
  await uploadAll(db, store, 3);

  assert.deepEqual(await uploadComplete(db, MEETING, 3, 180), { status: 'complete' });

  // Invariant #3: the client retries the call after a dropped response.
  assert.deepEqual(await uploadComplete(db, MEETING, 3, 180), { status: 'complete' });
  assert.deepEqual(await uploadComplete(db, MEETING, 3, 180), { status: 'complete' });

  const { rows } = await db.query<Job>(`SELECT * FROM jobs`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, 'transcribe');
  await db.close();
});

test('completion records duration and the summed true size', skipUnlessS3, async () => {
  const db = await freshDb();
  const store = await freshBucket();
  await uploadAll(db, store, 2);
  await uploadComplete(db, MEETING, 2, 120);

  const { rows } = await db.query<{
    status: string;
    duration_seconds: number;
    audio_size_bytes: string;
    segments_total: number;
  }>(`SELECT status, duration_seconds, audio_size_bytes, segments_total FROM meetings`);

  assert.equal(rows[0].status, 'uploaded');
  assert.equal(rows[0].duration_seconds, 120);
  assert.equal(rows[0].segments_total, 2);
  assert.equal(Number(rows[0].audio_size_bytes), 'audio-0'.length + 'audio-1'.length);
  await db.close();
});

test('re-uploading a segment after completion does not re-enqueue', skipUnlessS3, async () => {
  const db = await freshDb();
  const store = await freshBucket();
  const init = await uploadAll(db, store, 2);
  await uploadComplete(db, MEETING, 2, 120);

  // A late retry from a client that never saw the first response.
  await putViaPresignedUrl(init.segments[0].url, 'audio-0');
  await segmentUploaded(db, store, MEETING, 0);
  await uploadComplete(db, MEETING, 2, 120);

  const { rows } = await db.query<Job>(`SELECT * FROM jobs`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].attempts, 0);
  await db.close();
});
