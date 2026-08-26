import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from './nodeDb';
import { fakeServer } from './syncApi';
import { syncOnce, type SyncDeps } from '../src/sync/engine';
import { ApiError } from '../src/sync/api';
import {
  addSegment,
  createRecording,
  finalizeRecording,
  getRecording,
  listSegments,
  setState,
} from '../src/db/recordings';
import type { SqlDb } from '../src/db/adapter';

const ID = 'rec-1';
const CREATED = '2026-08-26T09:00:00.000Z';
const ONLINE = { online: true, wifi: true };

let clock = new Date('2026-08-26T10:00:00.000Z');
const now = () => clock;
const noJitter = () => 0.5;

async function seed(db: SqlDb, segments = 3, opts: { wifiOnly?: boolean } = {}) {
  clock = new Date('2026-08-26T10:00:00.000Z');
  await createRecording(db, ID, CREATED, '/rec/rec-1');
  for (let seq = 0; seq < segments; seq++) {
    await addSegment(db, {
      recording_id: ID,
      seq,
      file_path: `/rec/rec-1/seg-${seq}.m4a`,
      duration_ms: 60_000,
      size_bytes: 480_000,
    });
  }
  await finalizeRecording(db, ID);
  if (opts.wifiOnly === false) {
    await db.run(`UPDATE recordings SET wifi_only = 0 WHERE id = ?`, [ID]);
  }
}

function deps(db: SqlDb, server: ReturnType<typeof fakeServer>): SyncDeps {
  return {
    db,
    api: server.api,
    readSegment: async (path) => new TextEncoder().encode(`audio:${path}`),
    now,
    random: noJitter,
  };
}

test('a recorded meeting uploads and reaches uploaded', async () => {
  const db = await testDb();
  const server = fakeServer();
  await seed(db, 3);

  const out = await syncOnce(deps(db, server), ONLINE);

  assert.deepEqual(out.completed, [ID]);
  assert.equal((await getRecording(db, ID))?.state, 'uploaded');
  assert.deepEqual(server.landedFor(ID), [0, 1, 2]);
  assert.equal(server.count('putSegment'), 3);
});

test('a second pass does nothing — no re-upload, no duplicate work', async () => {
  const db = await testDb();
  const server = fakeServer();
  await seed(db, 3);

  await syncOnce(deps(db, server), ONLINE);
  const after = server.count('putSegment');
  const out = await syncOnce(deps(db, server), ONLINE);

  assert.equal(out.attempted, 0, 'an uploaded recording was picked up again');
  assert.equal(server.count('putSegment'), after);
});

test('invariant 2: a drop mid-upload resumes without re-sending what landed', async () => {
  const db = await testDb();
  // Fail the third PUT of the first pass.
  const server = fakeServer({
    failOn: (call, n) => (call === 'putSegment' && n === 3 ? new Error('network lost') : null),
  });
  await seed(db, 5);

  const first = await syncOnce(deps(db, server), ONLINE);
  assert.deepEqual(first.failed, [ID]);
  assert.deepEqual(server.landedFor(ID), [0, 1], 'wrong segments survived the drop');

  clock = new Date(clock.getTime() + 60_000);
  const second = await syncOnce(deps(db, server), ONLINE);

  assert.deepEqual(second.completed, [ID]);
  assert.deepEqual(server.landedFor(ID), [0, 1, 2, 3, 4]);
  // Two landed before the failure; only the remaining three are re-sent.
  assert.equal(server.count('putSegment'), 2 + 1 + 3, 'a landed segment was re-uploaded');
});

test('a failure records the error and schedules a backoff', async () => {
  const db = await testDb();
  const server = fakeServer({ failOn: (c) => (c === 'uploadInit' ? new Error('offline') : null) });
  await seed(db, 2);

  await syncOnce(deps(db, server), ONLINE);

  const row = await getRecording(db, ID);
  assert.equal(row?.state, 'queued', 'did not return to queued after failing');
  assert.equal(row?.attempts, 1);
  assert.match(row?.last_error ?? '', /offline/);
  assert.equal(row?.next_retry_at, '2026-08-26T10:00:30.000Z');
});

test('a recording is not retried before its backoff elapses', async () => {
  const db = await testDb();
  const server = fakeServer({ failOn: (c) => (c === 'uploadInit' ? new Error('offline') : null) });
  await seed(db, 2);
  await syncOnce(deps(db, server), ONLINE);
  const after = server.count('uploadInit');

  const out = await syncOnce(deps(db, server), ONLINE);
  assert.equal(out.attempted, 0);
  assert.equal(server.count('uploadInit'), after);

  clock = new Date('2026-08-26T10:01:00.000Z');
  assert.equal((await syncOnce(deps(db, server), ONLINE)).attempted, 1);
});

test('after 24 hours of failing, the recording is surfaced as stuck', async () => {
  const db = await testDb();
  const server = fakeServer({ failOn: (c) => (c === 'uploadInit' ? new Error('down') : null) });
  await seed(db, 1);

  await syncOnce(deps(db, server), ONLINE);
  assert.equal((await getRecording(db, ID))?.state, 'queued');

  clock = new Date('2026-08-27T10:00:01.000Z');
  await syncOnce(deps(db, server), ONLINE);

  assert.equal((await getRecording(db, ID))?.state, 'stuck', 'never surfaced to the user');
});

test('nothing is attempted while offline', async () => {
  const db = await testDb();
  const server = fakeServer();
  await seed(db, 2);

  const out = await syncOnce(deps(db, server), { online: false, wifi: false });

  assert.equal(out.attempted, 0);
  assert.equal(server.calls.length, 0);
  assert.equal((await getRecording(db, ID))?.state, 'recorded', 'state changed while offline');
});

test('wifi-only holds back on cellular, and the override releases it', async () => {
  const db = await testDb();
  const server = fakeServer();
  await seed(db, 2);

  const cellular = { online: true, wifi: false };
  const held = await syncOnce(deps(db, server), cellular);
  assert.equal(held.skipped, 1);
  assert.equal(server.calls.length, 0);

  await db.run(`UPDATE recordings SET wifi_only = 0 WHERE id = ?`, [ID]);
  const released = await syncOnce(deps(db, server), cellular);
  assert.deepEqual(released.completed, [ID]);
});

test('a segment the server lost is re-uploaded rather than looping', async () => {
  const db = await testDb();
  const server = fakeServer();
  await seed(db, 3);
  await syncOnce(deps(db, server), ONLINE);

  // The client believes all three landed; the server has lost one.
  await setState(db, ID, 'transcribing');
  await db.run(`UPDATE recordings SET state = 'queued' WHERE id = ?`, [ID]);
  server.dropServerSide(ID, 1);
  const before = server.count('putSegment');

  clock = new Date(clock.getTime() + 120_000);
  const out = await syncOnce(deps(db, server), ONLINE);
  assert.deepEqual(out.failed, [ID], 'the disagreement was not reported');

  clock = new Date(clock.getTime() + 120_000);
  const retry = await syncOnce(deps(db, server), ONLINE);
  assert.deepEqual(retry.completed, [ID]);
  assert.deepEqual(server.landedFor(ID), [0, 1, 2]);
  assert.equal(server.count('putSegment'), before + 1, 'more than the lost segment was re-sent');
});

test('a recording with no segments fails loudly instead of completing empty', async () => {
  const db = await testDb();
  const server = fakeServer();
  clock = new Date('2026-08-26T10:00:00.000Z');
  await createRecording(db, ID, CREATED, '/rec/rec-1');
  await finalizeRecording(db, ID);

  const out = await syncOnce(deps(db, server), ONLINE);

  assert.deepEqual(out.failed, [ID]);
  assert.match((await getRecording(db, ID))?.last_error ?? '', /no segments/);
  assert.equal(server.count('uploadComplete'), 0);
});

test('local audio is never deleted by a sync pass', async () => {
  const db = await testDb();
  const server = fakeServer();
  await seed(db, 3);

  await syncOnce(deps(db, server), ONLINE);

  // Invariant #10: upload success is not transcription success.
  const segs = await listSegments(db, ID);
  assert.equal(segs.length, 3);
  assert.ok(segs.every((s) => s.file_path.length > 0));
});

test('a non-retryable API error is still recorded, not swallowed', async () => {
  const db = await testDb();
  const server = fakeServer({
    failOn: (c) => (c === 'uploadInit' ? new ApiError('bad request', 400) : null),
  });
  await seed(db, 1);

  const out = await syncOnce(deps(db, server), ONLINE);

  assert.deepEqual(out.failed, [ID]);
  const row = await getRecording(db, ID);
  assert.match(row?.last_error ?? '', /bad request/);
  assert.equal(row?.attempts, 1);
});
