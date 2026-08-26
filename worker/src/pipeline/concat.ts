import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Sql } from '../sql.js';
import { meetingAudioKey, type Storage } from '../storage.js';
import { durationMs, ffmpeg } from './ffmpeg.js';

/**
 * AAC frames quantise duration, so a join is never sample-exact. One frame is
 * ~23ms at 44.1kHz; 250ms absorbs that across a 30-segment meeting while still
 * catching a dropped segment (60s).
 */
const TOLERANCE_MS = 250;

export type ConcatResult = {
  key: string;
  durationMs: number;
  segments: number;
  /** True when a previous run had already produced the file. */
  reused: boolean;
};

/**
 * Joins a meeting's segments into one m4a and stores it as the meeting's audio.
 *
 * One file matters beyond tidiness: transcribing segments separately would
 * restart diarization every 60 seconds, so "Speaker 1" in minute 3 would be
 * unrelated to "Speaker 1" in minute 4 — which breaks the meeting-scoped
 * speaker labels in §7. One file means one diarization pass.
 *
 * Segments are kept afterwards. They are the originals (§4.1), and the phone
 * deletes its copies only after transcription succeeds (invariant #10).
 */
export async function concatSegments(
  sql: Sql,
  store: Storage,
  meetingId: string
): Promise<ConcatResult> {
  const key = meetingAudioKey(meetingId);

  const { rows } = await sql.query<{ seq: number; audio_key: string }>(
    `SELECT seq, audio_key FROM meeting_segments
      WHERE meeting_id = $1 AND uploaded_at IS NOT NULL
      ORDER BY seq`,
    [meetingId]
  );
  if (rows.length === 0) throw new Error(`no uploaded segments for ${meetingId}`);

  const expected = await expectedSegmentCount(sql, meetingId);
  if (expected != null && rows.length !== expected) {
    // Refuse rather than transcribe a recording with a hole in it.
    throw new Error(
      `expected ${expected} segments for ${meetingId}, found ${rows.length} uploaded`
    );
  }

  const dir = await mkdtemp(join(tmpdir(), `concat-${meetingId}-`));
  try {
    // Idempotent: a retry after the upload succeeded but the job died must not
    // redo the work (§6.1).
    const existing = await store.head(key);
    if (existing && existing.size > 0) {
      const probe = join(dir, 'existing.m4a');
      await store.download(key, probe);
      return {
        key,
        durationMs: await durationMs(probe),
        segments: rows.length,
        reused: true,
      };
    }

    // Probe every segment before joining. ffmpeg's concat demuxer skips an
    // unreadable input and still exits 0, so without this a corrupt segment
    // would silently yield a short recording.
    const local: string[] = [];
    let expectedMs = 0;
    for (const row of rows) {
      const path = join(dir, `${String(row.seq).padStart(4, '0')}.m4a`);
      await store.download(row.audio_key, path);
      try {
        expectedMs += await durationMs(path);
      } catch (e) {
        throw new Error(`segment ${row.seq} of ${meetingId} is unreadable: ${e}`);
      }
      local.push(path);
    }

    const out = join(dir, 'audio.m4a');
    if (local.length === 1) {
      // Nothing to join; re-muxing a single file would only risk changing it.
      await ffmpeg(['-y', '-i', local[0], '-c', 'copy', out]);
    } else {
      const listFile = join(dir, 'segments.txt');
      await writeFile(
        listFile,
        local.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'),
        'utf8'
      );
      // -c copy: no re-encode, so the audio stays bit-identical to what the
      // phone captured and concatenation costs no quality.
      await ffmpeg([
        '-y',
        '-f', 'concat',
        '-safe', '0',
        '-i', listFile,
        '-c', 'copy',
        out,
      ]);
    }

    const ms = await durationMs(out);
    // Last line of defence: whatever ffmpeg reported, the joined file must be
    // as long as its inputs. Anything shorter means audio was dropped.
    const shortfall = expectedMs - ms;
    if (shortfall > TOLERANCE_MS) {
      throw new Error(
        `joined audio for ${meetingId} is ${shortfall}ms short of its ` +
          `${rows.length} segments (${expectedMs}ms expected, ${ms}ms produced)`
      );
    }
    await store.upload(key, out, 'audio/mp4');
    await sql.query(
      `UPDATE meetings
          SET audio_key = $2,
              duration_seconds = COALESCE(duration_seconds, $3)
        WHERE id = $1`,
      [meetingId, key, Math.round(ms / 1000)]
    );

    return { key, durationMs: ms, segments: rows.length, reused: false };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function expectedSegmentCount(sql: Sql, meetingId: string): Promise<number | null> {
  const { rows } = await sql.query<{ segments_total: number | null }>(
    `SELECT segments_total FROM meetings WHERE id = $1`,
    [meetingId]
  );
  return rows[0]?.segments_total ?? null;
}
