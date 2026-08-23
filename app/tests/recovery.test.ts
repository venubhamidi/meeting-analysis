import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from './nodeDb';
import { addSegment, createRecording, getRecording, listSegments } from '../src/db/recordings';
import { recoverInterruptedRecordings, type DiskSegment } from '../src/recording/recovery';

const onDisk = (dir: string, ...names: string[]): DiskSegment[] =>
  names.map((name) => ({ name, uri: `${dir}/${name}`, size: 500_000 }));

test('invariant 1: a crash mid-recording leaves the committed segments intact', async () => {
  const db = await testDb();
  await createRecording(db, 'r1', '2026-08-23T10:00:00.000Z', '/rec/r1');
  await addSegment(db, {
    recording_id: 'r1', seq: 0, file_path: '/rec/r1/seg-0000.m4a',
    duration_ms: 60_000, size_bytes: 500_000,
  });

  const recovered = await recoverInterruptedRecordings(db, (dir) =>
    onDisk(dir, 'seg-0000.m4a')
  );

  assert.deepEqual(recovered, ['r1']);
  const row = await getRecording(db, 'r1');
  assert.equal(row?.state, 'recorded');
  assert.equal(row?.duration_seconds, 60);
});

test('a segment moved into place but not yet recorded is adopted, not lost', async () => {
  const db = await testDb();
  await createRecording(db, 'r1', '2026-08-23T10:00:00.000Z', '/rec/r1');
  await addSegment(db, {
    recording_id: 'r1', seq: 0, file_path: '/rec/r1/seg-0000.m4a',
    duration_ms: 60_000, size_bytes: 500_000,
  });

  await recoverInterruptedRecordings(db, (dir) =>
    onDisk(dir, 'seg-0000.m4a', 'seg-0001.m4a')
  );

  const segments = await listSegments(db, 'r1');
  assert.equal(segments.length, 2);
  assert.equal(segments[1].duration_ms, null); // unknown, but the audio survives
  assert.equal(segments[1].file_path, '/rec/r1/seg-0001.m4a');
  // Duration reflects only the segments whose length is known.
  assert.equal((await getRecording(db, 'r1'))?.duration_seconds, 60);
});

test('recovery ignores unrelated files and is safe to run twice', async () => {
  const db = await testDb();
  await createRecording(db, 'r1', '2026-08-23T10:00:00.000Z', '/rec/r1');
  const listing = (dir: string) => onDisk(dir, 'seg-0000.m4a', 'notes.txt', '.DS_Store');

  await recoverInterruptedRecordings(db, listing);
  const again = await recoverInterruptedRecordings(db, listing);

  assert.deepEqual(again, []); // nothing left in `recording` state
  assert.equal((await listSegments(db, 'r1')).length, 1);
});

test('recovery leaves already-finalized recordings alone', async () => {
  const db = await testDb();
  await createRecording(db, 'r1', '2026-08-23T10:00:00.000Z', '/rec/r1');
  await recoverInterruptedRecordings(db, (dir) => onDisk(dir, 'seg-0000.m4a'));
  const recovered = await recoverInterruptedRecordings(db, (dir) =>
    onDisk(dir, 'seg-0000.m4a', 'seg-0001.m4a')
  );
  assert.deepEqual(recovered, []);
  assert.equal((await listSegments(db, 'r1')).length, 1);
});
