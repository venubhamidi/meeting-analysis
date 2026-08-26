import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { SarvamClient } from '../src/pipeline/sarvam.js';
import { transcribeMeeting } from '../src/pipeline/transcribe.js';
import { segmentKey } from '../src/storage.js';
import { tmpDir } from './audio.js';
import { fileURLToPath } from 'node:url';
import { freshDb, MEETING } from './harness.js';
import { freshBucket, skipUnlessS3 } from './storage.js';

/**
 * Hits the real Sarvam API and costs money. Runs only with LIVE_SARVAM=1 and a
 * key present. Everything else stubs the client; this exists so the protocol
 * itself is checked against the provider, not against my assumptions about it.
 */
const KEY = process.env.SARVAM_API_KEY;
const live = {
  skip:
    process.env.LIVE_SARVAM === '1' && KEY && !skipUnlessS3.skip
      ? false
      : 'set LIVE_SARVAM=1, SARVAM_API_KEY and TEST_S3_ENDPOINT',
};

test('a real recording transcribes end to end through the pipeline', live, async () => {
  const db = await freshDb();
  const store = await freshBucket();
  const dir = await tmpDir('live-');

  // Real Telugu speech, split as the app would segment it.
  await db.query(
    `INSERT INTO meetings (id, user_id, created_at, segments_total, status)
     VALUES ($1, 'u1', now(), 2, 'uploaded')`,
    [MEETING]
  );
  for (let seq = 0; seq < 2; seq++) {
    const file = fileURLToPath(new URL(`./fixtures/speech-${seq}.m4a`, import.meta.url));
    const key = segmentKey(MEETING, seq);
    await store.upload(key, file, 'audio/mp4');
    await db.query(
      `INSERT INTO meeting_segments (meeting_id, seq, audio_key, uploaded_at)
       VALUES ($1, $2, $3, now())`,
      [MEETING, seq, key]
    );
  }

  const sarvam = new SarvamClient({ apiKey: KEY!, pollIntervalMs: 3_000 });
  const result = await transcribeMeeting(db, store, sarvam, MEETING);

  assert.ok(result.segments > 0, 'no transcript segments came back');
  assert.equal(result.speakers, 2, 'diarization did not separate the two speakers');

  const { rows } = await db.query<{ status: string }>(
    `SELECT status FROM meetings WHERE id = $1`,
    [MEETING]
  );
  assert.equal(rows[0].status, 'transcribed');

  const segs = await db.query<{ text_te: string; diarization_label: string }>(
    `SELECT text_te, diarization_label FROM transcript_segments
      WHERE meeting_id = $1 ORDER BY seq`,
    [MEETING]
  );
  const all = segs.rows.map((r) => r.text_te).join(' ');
  // codemix keeps English in Latin script and Telugu in Telugu script.
  assert.match(all, /village|water|engineer/i, `no English survived: ${all}`);
  assert.match(all, /[\u0C00-\u0C7F]/, `no Telugu script: ${all}`);
  console.log('live transcript:');
  for (const r of segs.rows) console.log(`  ${r.diarization_label}: ${r.text_te}`);

  await rm(dir, { recursive: true, force: true });
  await db.close();
});
