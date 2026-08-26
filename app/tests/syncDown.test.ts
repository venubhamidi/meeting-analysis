import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from './nodeDb';
import { fakeServer } from './syncApi';
import { syncDownOnce, localTranscript } from '../src/sync/syncDown';
import type { TranscriptSegment } from '../src/sync/api';
import {
  addSegment,
  createRecording,
  finalizeRecording,
  getRecording,
  setState,
} from '../src/db/recordings';
import type { SqlDb } from '../src/db/adapter';

const ID = 'rec-1';
const CREATED = '2026-08-26T09:00:00.000Z';

const SEGMENTS: TranscriptSegment[] = [
  { seq: 0, diarization_label: 'Speaker 1', start_ms: 0, end_ms: 4200,
    text_te: 'నమస్కారం అందరికీ', low_confidence: false },
  { seq: 1, diarization_label: 'Speaker 2', start_ms: 4400, end_ms: 9100,
    text_te: 'మా ఊళ్లో నీటి సమస్య ఉంది', low_confidence: false },
];

/** A recording that has finished uploading and is waiting on the server. */
async function uploaded(db: SqlDb) {
  await createRecording(db, ID, CREATED, '/rec/rec-1');
  await addSegment(db, {
    recording_id: ID, seq: 0, file_path: '/rec/rec-1/seg-0.m4a',
    duration_ms: 60_000, size_bytes: 480_000,
  });
  await finalizeRecording(db, ID);
  for (const s of ['queued', 'uploading', 'uploaded'] as const) {
    await setState(db, ID, s);
  }
}

test('a transcribed meeting is pulled down and stored locally', async () => {
  const db = await testDb();
  const server = fakeServer();
  await uploaded(db);
  server.setTranscript(ID, 'transcribed', SEGMENTS);

  const out = await syncDownOnce(db, server.api);

  assert.equal(out.transcripts, 1);
  assert.deepEqual(out.updated, [ID]);
  const stored = await localTranscript(db, ID);
  assert.equal(stored.length, 2);
  assert.equal(stored[1].text_te, 'మా ఊళ్లో నీటి సమస్య ఉంది');
});

test('the transcript is readable offline once stored', async () => {
  const db = await testDb();
  const server = fakeServer();
  await uploaded(db);
  server.setTranscript(ID, 'transcribed', SEGMENTS);
  await syncDownOnce(db, server.api);

  // No further server calls: this is what the detail screen reads.
  const before = server.calls.length;
  const offline = await localTranscript(db, ID);
  assert.equal(offline.length, 2);
  assert.equal(server.calls.length, before, 'reading the transcript hit the network');
});

test('the state machine is walked forward, never jumped', async () => {
  const db = await testDb();
  const server = fakeServer();
  await uploaded(db);
  // The server has already finished transcribing by the time we look.
  server.setTranscript(ID, 'transcribed', SEGMENTS);

  await syncDownOnce(db, server.api);

  // uploaded -> transcribing -> analyzed, each a legal transition.
  assert.equal((await getRecording(db, ID))?.state, 'analyzed');
});

test('a second pass re-stores the transcript without duplicating rows', async () => {
  const db = await testDb();
  const server = fakeServer();
  await uploaded(db);
  server.setTranscript(ID, 'transcribed', SEGMENTS);

  await syncDownOnce(db, server.api);
  await syncDownOnce(db, server.api);

  const rows = await db.all(`SELECT * FROM transcripts_local WHERE recording_id = ?`, [ID]);
  assert.equal(rows.length, 1);
  assert.equal((await localTranscript(db, ID)).length, 2);
});

test('a still-transcribing meeting stores nothing and stays put', async () => {
  const db = await testDb();
  const server = fakeServer();
  await uploaded(db);
  server.setTranscript(ID, 'transcribing', []);

  const out = await syncDownOnce(db, server.api);

  assert.equal(out.transcripts, 0);
  assert.equal((await getRecording(db, ID))?.state, 'transcribing');
  assert.deepEqual(await localTranscript(db, ID), []);
});

test('an unreachable server leaves the recording untouched', async () => {
  const db = await testDb();
  const server = fakeServer({
    failOn: (c) => (c === 'getRecording' ? new Error('offline') : null),
  });
  await uploaded(db);

  const out = await syncDownOnce(db, server.api);

  assert.deepEqual(out.updated, []);
  assert.equal((await getRecording(db, ID))?.state, 'uploaded');
});

test('recordings still uploading are not polled', async () => {
  const db = await testDb();
  const server = fakeServer();
  await createRecording(db, ID, CREATED, '/rec/rec-1');
  await finalizeRecording(db, ID); // state: recorded

  await syncDownOnce(db, server.api);

  assert.equal(server.count('getRecording'), 0);
});

test('a corrupt local transcript reads as empty rather than throwing', async () => {
  const db = await testDb();
  await uploaded(db);
  await db.run(
    `INSERT INTO transcripts_local (recording_id, transcript_json) VALUES (?, ?)`,
    [ID, 'not json at all']
  );
  assert.deepEqual(await localTranscript(db, ID), []);
});
