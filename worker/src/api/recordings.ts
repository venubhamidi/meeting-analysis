import type { Sql } from '../sql.js';
import { enqueue } from '../jobs/queue.js';
import { meetingAudioKey, segmentKey, type Storage } from '../storage.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

export type UploadInit = {
  meetingId: string;
  segments: { seq: number; key: string; url: string }[];
};

/**
 * Registers a recording and hands back a presigned PUT per segment.
 *
 * Idempotent on the client UUID (§9): calling it again — after a crash, or to
 * refresh expired URLs mid-resume — returns fresh URLs for whatever is still
 * missing without disturbing what has already landed.
 */
export async function uploadInit(
  sql: Sql,
  store: Storage,
  userId: string,
  input: {
    meetingId: string;
    createdAt: string;
    segments: { seq: number; sizeBytes?: number; durationMs?: number }[];
  }
): Promise<UploadInit> {
  const { meetingId } = input;

  await sql.query(
    `INSERT INTO meetings (id, user_id, created_at, status)
     VALUES ($1, $2, $3, 'uploading')
     ON CONFLICT (id) DO NOTHING`,
    [meetingId, userId, input.createdAt]
  );

  for (const seg of input.segments) {
    await sql.query(
      `INSERT INTO meeting_segments (meeting_id, seq, audio_key, size_bytes, duration_ms)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (meeting_id, seq) DO NOTHING`,
      [
        meetingId,
        seg.seq,
        segmentKey(meetingId, seg.seq),
        seg.sizeBytes ?? null,
        seg.durationMs ?? null,
      ]
    );
  }

  // Only what is still outstanding — a resume must not re-upload finished work.
  const { rows } = await sql.query<{ seq: number; audio_key: string }>(
    `SELECT seq, audio_key FROM meeting_segments
      WHERE meeting_id = $1 AND uploaded_at IS NULL
      ORDER BY seq`,
    [meetingId]
  );

  return {
    meetingId,
    segments: await Promise.all(
      rows.map(async (r) => ({
        seq: r.seq,
        key: r.audio_key,
        url: await store.presignPut(r.audio_key, 'audio/mp4'),
      }))
    ),
  };
}

/**
 * Marks one segment uploaded, after confirming the object is really in R2 at a
 * plausible size. A client that lies, or a PUT that silently truncated, is
 * rejected here rather than surfacing as a corrupt transcript later.
 */
export async function segmentUploaded(
  sql: Sql,
  store: Storage,
  meetingId: string,
  seq: number
): Promise<{ ok: true; sizeBytes: number } | { ok: false; reason: string }> {
  const { rows } = await sql.query<{ audio_key: string }>(
    `SELECT audio_key FROM meeting_segments WHERE meeting_id = $1 AND seq = $2`,
    [meetingId, seq]
  );
  if (rows.length === 0) return { ok: false, reason: 'unknown segment' };

  const head = await store.head(rows[0].audio_key);
  if (!head) return { ok: false, reason: 'object not found in storage' };
  if (head.size === 0) return { ok: false, reason: 'object is empty' };

  await sql.query(
    `UPDATE meeting_segments
        SET uploaded_at = now(), size_bytes = $3
      WHERE meeting_id = $1 AND seq = $2`,
    [meetingId, seq, head.size]
  );
  return { ok: true, sizeBytes: head.size };
}

export type CompleteResult =
  | { status: 'complete' }
  | { status: 'incomplete'; missing: number[] };

/**
 * Closes out an upload and enqueues transcription.
 *
 * Refuses to proceed while any segment is missing — a partial recording must
 * never be transcribed as if it were whole. Enqueueing is idempotent, so a
 * client retrying this call cannot cause a second transcription charge
 * (invariant #3).
 */
export async function uploadComplete(
  sql: Sql,
  meetingId: string,
  segmentsTotal: number,
  durationSeconds: number | null
): Promise<CompleteResult> {
  const { rows } = await sql.query<{ seq: number }>(
    `SELECT seq FROM meeting_segments
      WHERE meeting_id = $1 AND uploaded_at IS NOT NULL ORDER BY seq`,
    [meetingId]
  );
  const have = new Set(rows.map((r) => r.seq));
  const missing = Array.from({ length: segmentsTotal }, (_, i) => i).filter(
    (i) => !have.has(i)
  );
  if (missing.length > 0) return { status: 'incomplete', missing };

  await sql.query(
    `UPDATE meetings
        SET status = 'uploaded',
            segments_total = $2,
            duration_seconds = COALESCE($3, duration_seconds),
            audio_key = $4,
            audio_size_bytes = (
              SELECT COALESCE(sum(size_bytes), 0) FROM meeting_segments WHERE meeting_id = $1
            )
      WHERE id = $1`,
    [meetingId, segmentsTotal, durationSeconds, meetingAudioKey(meetingId)]
  );
  await enqueue(sql, meetingId, 'transcribe');
  return { status: 'complete' };
}
