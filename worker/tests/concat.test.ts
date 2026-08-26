import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { concatSegments } from '../src/pipeline/concat.js';
import { durationMs } from '../src/pipeline/ffmpeg.js';
import { meetingAudioKey, segmentKey } from '../src/storage.js';
import type { Storage } from '../src/storage.js';
import type { Sql } from '../src/sql.js';
import { energyAt, makeSegment, tmpDir } from './audio.js';
import { freshDb, MEETING } from './harness.js';
import { freshBucket, skipUnlessS3 } from './storage.js';

const LOW = 300;
const MID = 900;
const HIGH = 2500;

/** Puts real AAC segments into storage and marks them uploaded. */
async function seedSegments(
  sql: Sql,
  store: Storage,
  tones: number[],
  seconds = 2
): Promise<string> {
  const dir = await tmpDir('seed-');
  await sql.query(
    `INSERT INTO meetings (id, user_id, created_at, segments_total)
     VALUES ($1, 'u1', now(), $2)`,
    [MEETING, tones.length]
  );
  for (const [seq, hz] of tones.entries()) {
    const file = await makeSegment(dir, `seg-${seq}.m4a`, seconds, hz);
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

test('segments are joined into one file of the summed duration', skipUnlessS3, async () => {
  const db = await freshDb();
  const store = await freshBucket();
  const dir = await seedSegments(db, store, [MID, MID, MID], 2);

  const result = await concatSegments(db, store, MEETING);

  assert.equal(result.segments, 3);
  assert.equal(result.reused, false);
  assert.equal(result.key, meetingAudioKey(MEETING));
  // AAC frames quantise duration slightly; 150ms of slack over 6s.
  assert.ok(
    Math.abs(result.durationMs - 6000) < 150,
    `expected ~6000ms, got ${result.durationMs}`
  );

  const stored = await store.head(result.key);
  assert.ok(stored && stored.size > 0);
  await rm(dir, { recursive: true, force: true });
  await db.close();
});

test('segments are joined in order, verified by their audio content', skipUnlessS3, async () => {
  const db = await freshDb();
  const store = await freshBucket();
  const dir = await seedSegments(db, store, [LOW, MID, HIGH], 2);

  await concatSegments(db, store, MEETING);

  const out = `${dir}/joined.m4a`;
  await store.download(meetingAudioKey(MEETING), out);

  // Each 2s window must carry the tone of the segment that belongs there.
  const first = { low: await energyAt(out, 1, LOW), high: await energyAt(out, 1, HIGH) };
  const last = { low: await energyAt(out, 5, LOW), high: await energyAt(out, 5, HIGH) };

  assert.ok(first.low > first.high + 10, 'first segment is not the low tone');
  assert.ok(last.high > last.low + 10, 'last segment is not the high tone');
  await rm(dir, { recursive: true, force: true });
  await db.close();
});

test('the joined audio is a re-mux, not a re-encode', skipUnlessS3, async () => {
  const db = await freshDb();
  const store = await freshBucket();
  const dir = await seedSegments(db, store, [MID, MID], 2);

  await concatSegments(db, store, MEETING);
  const out = `${dir}/joined.m4a`;
  await store.download(meetingAudioKey(MEETING), out);

  // A re-encode would lose energy at the tone; -c copy preserves it.
  const original = await energyAt(`${dir}/seg-0.m4a`, 0.5, MID);
  const joined = await energyAt(out, 0.5, MID);
  assert.ok(
    Math.abs(joined - original) < 1,
    `tone energy changed: ${original} -> ${joined}`
  );
  await rm(dir, { recursive: true, force: true });
  await db.close();
});

test('a single-segment recording still produces a playable file', skipUnlessS3, async () => {
  const db = await freshDb();
  const store = await freshBucket();
  const dir = await seedSegments(db, store, [MID], 3);

  const result = await concatSegments(db, store, MEETING);

  assert.equal(result.segments, 1);
  assert.ok(Math.abs(result.durationMs - 3000) < 150);
  const out = `${dir}/single.m4a`;
  await store.download(result.key, out);
  assert.ok(Math.abs((await durationMs(out)) - 3000) < 150);
  await rm(dir, { recursive: true, force: true });
  await db.close();
});

test('concat records the duration on the meeting when it was unknown', skipUnlessS3, async () => {
  const db = await freshDb();
  const store = await freshBucket();
  const dir = await seedSegments(db, store, [MID, MID], 2);

  await concatSegments(db, store, MEETING);

  const { rows } = await db.query<{ duration_seconds: number; audio_key: string }>(
    `SELECT duration_seconds, audio_key FROM meetings WHERE id = $1`,
    [MEETING]
  );
  assert.equal(rows[0].duration_seconds, 4);
  assert.equal(rows[0].audio_key, meetingAudioKey(MEETING));
  await rm(dir, { recursive: true, force: true });
  await db.close();
});

test('a client-reported duration is not overwritten by the probe', skipUnlessS3, async () => {
  const db = await freshDb();
  const store = await freshBucket();
  const dir = await seedSegments(db, store, [MID, MID], 2);
  await db.query(`UPDATE meetings SET duration_seconds = 99 WHERE id = $1`, [MEETING]);

  await concatSegments(db, store, MEETING);

  const { rows } = await db.query<{ duration_seconds: number }>(
    `SELECT duration_seconds FROM meetings WHERE id = $1`,
    [MEETING]
  );
  assert.equal(rows[0].duration_seconds, 99);
  await rm(dir, { recursive: true, force: true });
  await db.close();
});

test('a retry after a crash reuses the finished file instead of redoing it', skipUnlessS3, async () => {
  const db = await freshDb();
  const store = await freshBucket();
  const dir = await seedSegments(db, store, [MID, MID], 2);

  const first = await concatSegments(db, store, MEETING);
  const stored = await store.head(first.key);

  const second = await concatSegments(db, store, MEETING);

  assert.equal(second.reused, true);
  assert.ok(Math.abs(second.durationMs - first.durationMs) < 50);
  assert.deepEqual(await store.head(first.key), stored, 'the file was rewritten');
  await rm(dir, { recursive: true, force: true });
  await db.close();
});

test('a recording missing a segment is refused, not silently shortened', skipUnlessS3, async () => {
  const db = await freshDb();
  const store = await freshBucket();
  const dir = await seedSegments(db, store, [MID, MID, MID], 2);
  // Segment 1 never made it, though the client said there were three.
  await db.query(`DELETE FROM meeting_segments WHERE meeting_id = $1 AND seq = 1`, [
    MEETING,
  ]);

  await assert.rejects(
    () => concatSegments(db, store, MEETING),
    /expected 3 segments.*found 2/
  );
  assert.equal(await store.head(meetingAudioKey(MEETING)), null);
  await rm(dir, { recursive: true, force: true });
  await db.close();
});

test('a recording with no uploaded segments is refused', skipUnlessS3, async () => {
  const db = await freshDb();
  const store = await freshBucket();
  await db.query(
    `INSERT INTO meetings (id, user_id, created_at) VALUES ($1, 'u1', now())`,
    [MEETING]
  );

  await assert.rejects(() => concatSegments(db, store, MEETING), /no uploaded segments/);
  await db.close();
});

test('a corrupt segment fails loudly rather than producing partial audio', skipUnlessS3, async () => {
  const db = await freshDb();
  const store = await freshBucket();
  const dir = await seedSegments(db, store, [MID, MID], 2);
  // Overwrite one segment with bytes that are not audio at all.
  const junk = `${dir}/junk.m4a`;
  await (await import('node:fs/promises')).writeFile(junk, 'not an m4a file');
  await store.upload(segmentKey(MEETING, 1), junk, 'audio/mp4');

  await assert.rejects(() => concatSegments(db, store, MEETING), /segment 1 .* unreadable/);
  assert.equal(await store.head(meetingAudioKey(MEETING)), null);
  await rm(dir, { recursive: true, force: true });
  await db.close();
});

test('silent truncation by ffmpeg is caught by the duration check', skipUnlessS3, async () => {
  const db = await freshDb();
  const store = await freshBucket();
  const dir = await seedSegments(db, store, [MID, MID], 2);

  // A segment at a different sample rate. Both files probe fine, and the
  // concat demuxer drops the second one while exiting 0 with no output at
  // all — the only signal is that the result is too short.
  const odd = await makeSegment(dir, 'odd.m4a', 2, MID, 22050);
  await store.upload(segmentKey(MEETING, 1), odd, 'audio/mp4');

  await assert.rejects(
    () => concatSegments(db, store, MEETING),
    /short of its 2 segments/
  );
  assert.equal(await store.head(meetingAudioKey(MEETING)), null);
  await rm(dir, { recursive: true, force: true });
  await db.close();
});
