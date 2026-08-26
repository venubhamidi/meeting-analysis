import type { SqlDb } from './adapter';
import { transition, type RecordingState } from '../recording/states';

export type RecordingRow = {
  id: string;
  created_at: string;
  duration_seconds: number | null;
  file_path: string;
  file_size_bytes: number | null;
  state: RecordingState;
  attempts: number;
  first_attempt_at: string | null;
  next_retry_at: string | null;
  last_error: string | null;
  /** SQLite has no boolean; 1 = upload only on WiFi (the default). */
  wifi_only: number;
  notes_text: string | null;
};

export type SegmentRow = {
  recording_id: string;
  seq: number;
  file_path: string;
  duration_ms: number | null;
  size_bytes: number | null;
};

export async function createRecording(
  db: SqlDb,
  id: string,
  createdAt: string,
  dirPath: string
): Promise<void> {
  await db.run(
    `INSERT INTO recordings (id, created_at, file_path, state) VALUES (?, ?, ?, 'recording')`,
    [id, createdAt, dirPath]
  );
}

/** Idempotent: re-committing the same segment number is harmless. */
export async function addSegment(db: SqlDb, seg: SegmentRow): Promise<void> {
  await db.run(
    `INSERT OR IGNORE INTO recording_segments
       (recording_id, seq, file_path, duration_ms, size_bytes)
     VALUES (?, ?, ?, ?, ?)`,
    [seg.recording_id, seg.seq, seg.file_path, seg.duration_ms, seg.size_bytes]
  );
}

export async function listSegments(db: SqlDb, recordingId: string): Promise<SegmentRow[]> {
  return db.all<SegmentRow>(
    `SELECT * FROM recording_segments WHERE recording_id = ? ORDER BY seq`,
    [recordingId]
  );
}

export async function nextSegmentSeq(db: SqlDb, recordingId: string): Promise<number> {
  const row = await db.first<{ n: number | null }>(
    `SELECT MAX(seq) AS n FROM recording_segments WHERE recording_id = ?`,
    [recordingId]
  );
  return (row?.n ?? -1) + 1;
}

export async function getRecording(db: SqlDb, id: string): Promise<RecordingRow | null> {
  return db.first<RecordingRow>(`SELECT * FROM recordings WHERE id = ?`, [id]);
}

export async function listRecordings(db: SqlDb): Promise<RecordingRow[]> {
  return db.all<RecordingRow>(`SELECT * FROM recordings ORDER BY created_at DESC`);
}

/** Rejects illegal transitions instead of writing an inconsistent state. */
export async function setState(db: SqlDb, id: string, to: RecordingState): Promise<void> {
  const row = await getRecording(db, id);
  if (!row) throw new Error(`no such recording: ${id}`);
  await db.run(`UPDATE recordings SET state = ? WHERE id = ?`, [
    transition(row.state, to),
    id,
  ]);
}

/**
 * Closes out a recording: totals are derived from the committed segments, so a
 * recording finalized by crash recovery gets the same treatment as a clean stop.
 */
export async function finalizeRecording(db: SqlDb, id: string): Promise<void> {
  const totals = await db.first<{ ms: number | null; bytes: number | null }>(
    `SELECT SUM(duration_ms) AS ms, SUM(size_bytes) AS bytes
       FROM recording_segments WHERE recording_id = ?`,
    [id]
  );
  const row = await getRecording(db, id);
  if (!row) throw new Error(`no such recording: ${id}`);
  await db.run(
    `UPDATE recordings
        SET state = ?, duration_seconds = ?, file_size_bytes = ?
      WHERE id = ?`,
    [
      row.state === 'recording' ? transition(row.state, 'recorded') : row.state,
      totals?.ms != null ? Math.round(totals.ms / 1000) : null,
      totals?.bytes ?? null,
      id,
    ]
  );
}

export async function listInterrupted(db: SqlDb): Promise<RecordingRow[]> {
  return db.all<RecordingRow>(`SELECT * FROM recordings WHERE state = 'recording'`);
}

/** Recordings still owed to the server, for the "N pending" banner (§4.4). */
export async function pendingCount(db: SqlDb): Promise<number> {
  const row = await db.first<{ n: number }>(
    `SELECT COUNT(*) AS n FROM recordings WHERE state NOT IN ('synced', 'recording')`
  );
  return row?.n ?? 0;
}

/** Segments not yet confirmed on the server, in order. */
export async function pendingSegments(
  db: SqlDb,
  recordingId: string
): Promise<SegmentRow[]> {
  return db.all<SegmentRow>(
    `SELECT * FROM recording_segments
      WHERE recording_id = ? AND uploaded_at IS NULL
      ORDER BY seq`,
    [recordingId]
  );
}

export async function markSegmentUploaded(
  db: SqlDb,
  recordingId: string,
  seq: number,
  at: string
): Promise<void> {
  await db.run(
    `UPDATE recording_segments SET uploaded_at = ? WHERE recording_id = ? AND seq = ?`,
    [at, recordingId, seq]
  );
}

/** Recordings the sync engine should work on, oldest first. */
export async function dueForSync(db: SqlDb, now: string): Promise<RecordingRow[]> {
  return db.all<RecordingRow>(
    `SELECT * FROM recordings
      WHERE state IN ('recorded', 'queued', 'uploading')
        AND (next_retry_at IS NULL OR next_retry_at <= ?)
      ORDER BY created_at`,
    [now]
  );
}

/** Records a failed attempt and schedules the next one. */
export async function recordFailure(
  db: SqlDb,
  id: string,
  error: string,
  nextRetry: string,
  now: string
): Promise<void> {
  await db.run(
    `UPDATE recordings
        SET attempts = attempts + 1,
            last_error = ?,
            next_retry_at = ?,
            first_attempt_at = COALESCE(first_attempt_at, ?)
      WHERE id = ?`,
    [error.slice(0, 500), nextRetry, now, id]
  );
}

export async function clearFailure(db: SqlDb, id: string, now: string): Promise<void> {
  await db.run(
    `UPDATE recordings
        SET attempts = 0, last_error = NULL, next_retry_at = NULL, last_synced_at = ?
      WHERE id = ?`,
    [now, id]
  );
}

export async function markStuck(db: SqlDb, id: string): Promise<void> {
  await db.run(`UPDATE recordings SET state = 'stuck' WHERE id = ?`, [id]);
}
