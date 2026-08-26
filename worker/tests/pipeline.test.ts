import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { transcribeMeeting } from '../src/pipeline/transcribe.js';
import type { SarvamResult } from '../src/pipeline/sarvam.js';
import { segmentKey } from '../src/storage.js';
import type { Storage } from '../src/storage.js';
import type { Sql } from '../src/sql.js';
import { handlers, tick } from '../src/worker.js';
import { failedJobs, enqueue, type Job } from '../src/jobs/queue.js';
import { makeSegment, tmpDir } from './audio.js';
import { freshDb, MEETING } from './harness.js';
import { freshBucket, skipUnlessS3 } from './storage.js';

const REAL: SarvamResult = JSON.parse(
  readFileSync(new URL('./fixtures/sarvam-codemix.json', import.meta.url), 'utf8')
);

/** Counts calls, so "never re-pay Sarvam" can be asserted. */
function stubSarvam(result: SarvamResult = REAL, fail?: Error) {
  const calls: string[] = [];
  return {
    calls,
    async transcribe(path: string) {
      calls.push(path);
      if (fail) throw fail;
      return result;
    },
  };
}

async function seed(sql: Sql, store: Storage, count = 2): Promise<string> {
  const dir = await tmpDir('pipe-');
  await sql.query(
    `INSERT INTO meetings (id, user_id, created_at, segments_total, status)
     VALUES ($1, 'u1', now(), $2, 'uploaded')`,
    [MEETING, count]
  );
  for (let seq = 0; seq < count; seq++) {
    const file = await makeSegment(dir, `s${seq}.m4a`, 2, 400 + seq * 200);
    const key = segmentKey(MEETING, seq);
    await store.upload(key, file, 'audio/mp4');
    await sql.query(
      `INSERT INTO meeting_segments (meeting_id, seq, audio_key, uploaded_at)
       VALUES ($1, $2, $3, now())`,
      [MEETING, seq, key]
    );
  }
  return dir;
}

test('a meeting goes from uploaded to transcribed with segments written', skipUnlessS3, async () => {
  const db = await freshDb();
  const store = await freshBucket();
  const dir = await seed(db, store);
  const sarvam = stubSarvam();

  const result = await transcribeMeeting(db, store, sarvam, MEETING);

  assert.equal(result.segments, 3);
  assert.equal(result.speakers, 2);
  assert.equal(result.skipped, false);

  const { rows } = await db.query<{ status: string }>(
    `SELECT status FROM meetings WHERE id = $1`,
    [MEETING]
  );
  assert.equal(rows[0].status, 'transcribed');

  const segs = await db.query<{ seq: number; diarization_label: string; text_te: string }>(
    `SELECT seq, diarization_label, text_te FROM transcript_segments
      WHERE meeting_id = $1 ORDER BY seq`,
    [MEETING]
  );
  assert.deepEqual(segs.rows.map((r) => r.seq), [0, 1, 2]);
  assert.match(segs.rows[0].diarization_label, /^Speaker \d+$/);
  assert.ok(segs.rows[0].text_te.length > 0);
  await rm(dir, { recursive: true, force: true });
  await db.close();
});

test('the transcript is searchable through Postgres FTS once written', skipUnlessS3, async () => {
  const db = await freshDb();
  const store = await freshBucket();
  const dir = await seed(db, store);
  await transcribeMeeting(db, store, stubSarvam(), MEETING);

  // "village" appears in the code-mixed transcript in Latin script.
  const { rows } = await db.query<{ n: string }>(
    `SELECT count(*) AS n FROM transcript_segments
      WHERE meeting_id = $1 AND tsv @@ plainto_tsquery('simple', 'village')`,
    [MEETING]
  );
  assert.ok(Number(rows[0].n) > 0, 'code-mixed English is not searchable');
  await rm(dir, { recursive: true, force: true });
  await db.close();
});

test('invariant 3: a re-run never calls Sarvam twice', skipUnlessS3, async () => {
  const db = await freshDb();
  const store = await freshBucket();
  const dir = await seed(db, store);
  const sarvam = stubSarvam();

  await transcribeMeeting(db, store, sarvam, MEETING);
  const second = await transcribeMeeting(db, store, sarvam, MEETING);

  assert.equal(second.skipped, true);
  assert.equal(sarvam.calls.length, 1, 'Sarvam was billed twice for one meeting');

  const { rows } = await db.query<{ n: string }>(
    `SELECT count(*) AS n FROM transcript_segments WHERE meeting_id = $1`,
    [MEETING]
  );
  assert.equal(Number(rows[0].n), 3, 'segments were duplicated');
  await rm(dir, { recursive: true, force: true });
  await db.close();
});

test('a Sarvam failure leaves no partial transcript behind', skipUnlessS3, async () => {
  const db = await freshDb();
  const store = await freshBucket();
  const dir = await seed(db, store);
  const sarvam = stubSarvam(REAL, new Error('sarvam 503'));

  await assert.rejects(() => transcribeMeeting(db, store, sarvam, MEETING), /sarvam 503/);

  const { rows } = await db.query<{ n: string }>(
    `SELECT count(*) AS n FROM transcript_segments WHERE meeting_id = $1`,
    [MEETING]
  );
  assert.equal(Number(rows[0].n), 0);
  await rm(dir, { recursive: true, force: true });
  await db.close();
});

test('an empty transcript is an error, not an empty success', skipUnlessS3, async () => {
  const db = await freshDb();
  const store = await freshBucket();
  const dir = await seed(db, store);

  await assert.rejects(
    () => transcribeMeeting(db, store, stubSarvam({ transcript: '' }), MEETING),
    /no usable transcript/
  );
  await rm(dir, { recursive: true, force: true });
  await db.close();
});

test('the worker drains a queued job end to end', skipUnlessS3, async () => {
  const db = await freshDb();
  const store = await freshBucket();
  const dir = await seed(db, store);
  const sarvam = stubSarvam();
  await enqueue(db, MEETING, 'transcribe');

  assert.equal(await tick(db, handlers(db, store, sarvam)), 1);
  assert.equal(await tick(db, handlers(db, store, sarvam)), 0, 'job was offered twice');

  const { rows } = await db.query<Job>(`SELECT * FROM jobs`);
  assert.equal(rows[0].status, 'done');
  assert.equal(sarvam.calls.length, 1);
  await rm(dir, { recursive: true, force: true });
  await db.close();
});

test('a failing job retries, then lands in failed with its reason', skipUnlessS3, async () => {
  const db = await freshDb();
  const store = await freshBucket();
  const dir = await seed(db, store);
  const sarvam = stubSarvam(REAL, new Error('sarvam is down'));
  await enqueue(db, MEETING, 'transcribe');
  await db.query(`UPDATE jobs SET max_attempts = 2`);

  const h = handlers(db, store, sarvam);
  for (let i = 0; i < 2; i++) {
    await tick(db, h);
    await db.query(`UPDATE jobs SET next_retry_at = now() - interval '1 second'`);
  }

  const failed = await failedJobs(db);
  assert.equal(failed.length, 1);
  assert.match(failed[0].last_error ?? '', /sarvam is down/);
  await rm(dir, { recursive: true, force: true });
  await db.close();
});

test('a job for a meeting with a missing segment fails without calling Sarvam', skipUnlessS3, async () => {
  const db = await freshDb();
  const store = await freshBucket();
  const dir = await seed(db, store, 3);
  await db.query(`DELETE FROM meeting_segments WHERE meeting_id = $1 AND seq = 1`, [MEETING]);
  const sarvam = stubSarvam();
  await enqueue(db, MEETING, 'transcribe');

  await tick(db, handlers(db, store, sarvam));

  assert.equal(sarvam.calls.length, 0, 'paid Sarvam for an incomplete recording');
  const { rows } = await db.query<Job>(`SELECT * FROM jobs`);
  assert.match(rows[0].last_error ?? '', /expected 3 segments/);
  await rm(dir, { recursive: true, force: true });
  await db.close();
});
