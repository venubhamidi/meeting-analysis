import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  claim,
  complete,
  enqueue,
  fail,
  failedJobs,
  reclaimExpired,
  type Job,
} from '../src/jobs/queue.js';
import { expire, freshDb, insertMeeting, MEETING, MEETING_2 } from './harness.js';

const noJitter = () => 0.5;

test('invariant 3: enqueueing the same stage twice creates one job', async () => {
  const db = await freshDb();
  await insertMeeting(db);
  await enqueue(db, MEETING, 'transcribe');
  await enqueue(db, MEETING, 'transcribe');
  await enqueue(db, MEETING, 'transcribe', { retriedCall: true });

  const { rows } = await db.query<Job>(`SELECT * FROM jobs`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].attempts, 0);
  await db.close();
});

test('a meeting can hold one job per stage', async () => {
  const db = await freshDb();
  await insertMeeting(db);
  await enqueue(db, MEETING, 'transcribe');
  await enqueue(db, MEETING, 'analyze');
  const { rows } = await db.query<Job>(`SELECT * FROM jobs`);
  assert.equal(rows.length, 2);
  await db.close();
});

test('claim takes only due jobs of the requested type, oldest first', async () => {
  const db = await freshDb();
  await insertMeeting(db, MEETING);
  await insertMeeting(db, MEETING_2);
  await enqueue(db, MEETING, 'transcribe');
  await enqueue(db, MEETING_2, 'transcribe');
  await enqueue(db, MEETING, 'analyze');

  const claimed = await claim(db, ['transcribe'], 10);
  assert.equal(claimed.length, 2);
  assert.equal(claimed[0].meeting_id, MEETING);
  assert.ok(claimed.every((j) => j.status === 'running'));

  // Already running, so a second poll finds nothing.
  assert.deepEqual(await claim(db, ['transcribe'], 10), []);
  await db.close();
});

test('a job scheduled into the future is not claimed yet', async () => {
  const db = await freshDb();
  await insertMeeting(db);
  await enqueue(db, MEETING, 'transcribe');
  const [job] = await claim(db, ['transcribe']);
  await fail(db, job, 'sarvam 503', noJitter);

  assert.deepEqual(await claim(db, ['transcribe']), []); // backoff not elapsed
  await expire(db, job.id);
  assert.equal((await claim(db, ['transcribe'])).length, 1);
  await db.close();
});

test('invariant 4: three failures then success leaves the job done, not failed', async () => {
  const db = await freshDb();
  await insertMeeting(db);
  await enqueue(db, MEETING, 'transcribe');

  let job!: Job;
  for (let i = 0; i < 3; i++) {
    [job] = await claim(db, ['transcribe']);
    assert.equal(await fail(db, job, `sarvam attempt ${i}`, noJitter), 'pending');
    await expire(db, job.id);
  }
  [job] = await claim(db, ['transcribe']);
  await complete(db, job.id);

  const { rows } = await db.query<Job>(`SELECT * FROM jobs WHERE id = $1`, [job.id]);
  assert.equal(rows[0].status, 'done');
  assert.equal(rows[0].attempts, 3);
  assert.equal(rows[0].last_error, null);
  await db.close();
});

test('a job exhausting max_attempts lands in failed, visible to an admin', async () => {
  const db = await freshDb();
  await insertMeeting(db);
  await enqueue(db, MEETING, 'transcribe');
  await db.query(`UPDATE jobs SET max_attempts = 3`);

  let status = 'pending';
  for (let i = 0; i < 3; i++) {
    const [job] = await claim(db, ['transcribe']);
    status = await fail(db, job, 'permanent problem', noJitter);
    await expire(db, job.id);
  }

  assert.equal(status, 'failed');
  const failed = await failedJobs(db);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].last_error, 'permanent problem');
  assert.deepEqual(await claim(db, ['transcribe']), []); // never retried again
  await db.close();
});

test('invariant 5: a failing analysis never re-runs transcription', async () => {
  const db = await freshDb();
  await insertMeeting(db);
  await enqueue(db, MEETING, 'transcribe');
  const [transcribe] = await claim(db, ['transcribe']);
  await complete(db, transcribe.id);
  await enqueue(db, MEETING, 'analyze');

  for (let i = 0; i < 3; i++) {
    const [analyze] = await claim(db, ['analyze']);
    await fail(db, analyze, 'claude 429', noJitter);
    await expire(db, analyze.id);
  }

  const { rows } = await db.query<Job>(`SELECT * FROM jobs ORDER BY type`);
  const byType = Object.fromEntries(rows.map((r) => [r.type, r]));
  assert.equal(byType.transcribe.status, 'done');
  assert.equal(byType.transcribe.attempts, 0);
  assert.equal(byType.analyze.attempts, 3);
  // Nothing re-offers the transcribe job, so Sarvam is never paid twice.
  assert.deepEqual(await claim(db, ['transcribe']), []);
  await db.close();
});

test('a job whose worker died is reclaimed once its lease expires', async () => {
  const db = await freshDb();
  await insertMeeting(db);
  await enqueue(db, MEETING, 'transcribe');
  const [job] = await claim(db, ['transcribe']);

  assert.equal(await reclaimExpired(db), 0); // lease still valid
  await expire(db, job.id);
  assert.equal(await reclaimExpired(db), 1);

  const [again] = await claim(db, ['transcribe']);
  assert.equal(again.id, job.id);
  assert.equal(again.attempts, 1); // the dead run counted
  await db.close();
});

test('a job that keeps killing its worker eventually fails instead of looping', async () => {
  const db = await freshDb();
  await insertMeeting(db);
  await enqueue(db, MEETING, 'transcribe');
  await db.query(`UPDATE jobs SET max_attempts = 2`);

  for (let i = 0; i < 2; i++) {
    const [job] = await claim(db, ['transcribe']);
    await expire(db, job.id);
    await reclaimExpired(db);
  }

  const failed = await failedJobs(db);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].last_error, 'worker lease expired');
  await db.close();
});
