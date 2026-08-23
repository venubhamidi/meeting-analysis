import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from './nodeDb';
import { migrate } from '../src/db/migrate';
import {
  addSegment,
  createRecording,
  finalizeRecording,
  getRecording,
  listRecordings,
  listSegments,
  nextSegmentSeq,
  pendingCount,
  setState,
} from '../src/db/recordings';

const seg = (id: string, seq: number, ms: number | null, bytes: number) => ({
  recording_id: id,
  seq,
  file_path: `/rec/${id}/seg-${seq}.m4a`,
  duration_ms: ms,
  size_bytes: bytes,
});

test('migrations are idempotent and land on the expected version', async () => {
  const db = await testDb();
  const applied = await migrate(db); // second run
  const v = await db.first<{ user_version: number }>('PRAGMA user_version');
  assert.equal(v?.user_version, applied);
  const tables = await db.all<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`
  );
  const names = tables.map((t) => t.name);
  for (const t of ['recordings', 'recording_segments', 'participants_local', 'transcripts_local']) {
    assert.ok(names.includes(t), `missing ${t}`);
  }
});

test('a new recording starts in recording state with no totals', async () => {
  const db = await testDb();
  await createRecording(db, 'r1', '2026-08-23T10:00:00.000Z', '/rec/r1');
  const row = await getRecording(db, 'r1');
  assert.equal(row?.state, 'recording');
  assert.equal(row?.duration_seconds, null);
});

test('segment commits are idempotent', async () => {
  const db = await testDb();
  await createRecording(db, 'r1', '2026-08-23T10:00:00.000Z', '/rec/r1');
  await addSegment(db, seg('r1', 0, 60_000, 100));
  await addSegment(db, seg('r1', 0, 60_000, 100));
  assert.equal((await listSegments(db, 'r1')).length, 1);
  assert.equal(await nextSegmentSeq(db, 'r1'), 1);
});

test('finalize derives duration and size from committed segments', async () => {
  const db = await testDb();
  await createRecording(db, 'r1', '2026-08-23T10:00:00.000Z', '/rec/r1');
  await addSegment(db, seg('r1', 0, 60_000, 500_000));
  await addSegment(db, seg('r1', 1, 45_500, 380_000));
  await finalizeRecording(db, 'r1');
  const row = await getRecording(db, 'r1');
  assert.equal(row?.state, 'recorded');
  assert.equal(row?.duration_seconds, 106);
  assert.equal(row?.file_size_bytes, 880_000);
});

test('finalize is safe on a recording with zero segments', async () => {
  const db = await testDb();
  await createRecording(db, 'r1', '2026-08-23T10:00:00.000Z', '/rec/r1');
  await finalizeRecording(db, 'r1');
  const row = await getRecording(db, 'r1');
  assert.equal(row?.state, 'recorded');
  assert.equal(row?.duration_seconds, null);
});

test('setState refuses an illegal jump and leaves the row untouched', async () => {
  const db = await testDb();
  await createRecording(db, 'r1', '2026-08-23T10:00:00.000Z', '/rec/r1');
  await finalizeRecording(db, 'r1');
  await assert.rejects(() => setState(db, 'r1', 'uploaded'), /illegal state transition/);
  assert.equal((await getRecording(db, 'r1'))?.state, 'recorded');
  await setState(db, 'r1', 'queued');
  assert.equal((await getRecording(db, 'r1'))?.state, 'queued');
});

test('pending count ignores synced and in-progress recordings', async () => {
  const db = await testDb();
  for (const id of ['r1', 'r2', 'r3']) {
    await createRecording(db, id, `2026-08-23T10:00:0${id[1]}.000Z`, `/rec/${id}`);
  }
  await finalizeRecording(db, 'r1'); // recorded  -> pending
  await finalizeRecording(db, 'r2');
  for (const s of ['queued', 'uploading', 'uploaded', 'transcribing', 'analyzed', 'synced'] as const) {
    await setState(db, 'r2', s); // r2 ends synced -> not pending
  }
  // r3 is still recording -> not pending
  assert.equal(await pendingCount(db), 1);
  assert.equal((await listRecordings(db)).length, 3);
});
