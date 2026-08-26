import type { SqlDb } from '../db/adapter';
import {
  clearFailure,
  dueForSync,
  listSegments,
  markSegmentUploaded,
  markStuck,
  pendingSegments,
  recordFailure,
  setState,
  type RecordingRow,
} from '../db/recordings';
import { nextRetryAt, shouldMarkStuck } from '../recording/backoff';
import { ApiError, type Api } from './api';

/** Reads a segment file off disk. Injected so the engine is testable in Node. */
export type ReadSegment = (path: string) => Promise<Uint8Array>;

export type Connectivity = { online: boolean; wifi: boolean };

export type SyncDeps = {
  db: SqlDb;
  api: Api;
  readSegment: ReadSegment;
  now: () => Date;
  random?: () => number;
};

export type SyncOutcome = {
  attempted: number;
  completed: string[];
  failed: string[];
  skipped: number;
};

/**
 * One pass over everything owed to the server.
 *
 * Nothing here deletes local audio: invariant #10 requires the server to
 * confirm *transcription*, which happens later in the sync-down path, not here.
 */
export async function syncOnce(
  deps: SyncDeps,
  net: Connectivity
): Promise<SyncOutcome> {
  const out: SyncOutcome = { attempted: 0, completed: [], failed: [], skipped: 0 };
  if (!net.online) return out;

  const now = deps.now();
  for (const row of await dueForSync(deps.db, now.toISOString())) {
    // WiFi-only is the default; a recording can be overridden to go on cellular.
    if (row.wifi_only && !net.wifi) {
      out.skipped++;
      continue;
    }
    out.attempted++;
    try {
      await syncRecording(deps, row);
      out.completed.push(row.id);
    } catch (e) {
      await handleFailure(deps, row, e);
      out.failed.push(row.id);
    }
  }
  return out;
}

async function syncRecording(deps: SyncDeps, row: RecordingRow): Promise<void> {
  const { db, api, readSegment, now } = deps;

  if (row.state === 'recorded') await setState(db, row.id, 'queued');
  if (row.state !== 'uploading') await setState(db, row.id, 'uploading');

  const all = await listSegments(db, row.id);
  if (all.length === 0) throw new Error('recording has no segments');

  // Ask only for what is still outstanding; the server re-issues URLs for
  // exactly those, so a resume never re-uploads finished segments.
  const pending = await pendingSegments(db, row.id);
  if (pending.length > 0) {
    const init = await api.uploadInit(
      row.id,
      row.created_at,
      pending.map((s) => ({
        seq: s.seq,
        sizeBytes: s.size_bytes ?? undefined,
        durationMs: s.duration_ms ?? undefined,
      }))
    );

    const byPath = new Map(all.map((s) => [s.seq, s.file_path]));
    for (const target of init.segments) {
      const path = byPath.get(target.seq);
      if (!path) continue;
      await api.putSegment(target.url, await readSegment(path));
      await api.confirmSegment(row.id, target.seq);
      await markSegmentUploaded(db, row.id, target.seq, now().toISOString());
    }
  }

  const result = await api.uploadComplete(
    row.id,
    all.length,
    row.duration_seconds ?? null
  );
  if (result.status !== 'complete') {
    // The server disagrees about what landed. Clear our local belief for the
    // missing ones so the next pass re-uploads them rather than looping.
    for (const seq of result.missing) {
      await db.run(
        `UPDATE recording_segments SET uploaded_at = NULL
          WHERE recording_id = ? AND seq = ?`,
        [row.id, seq]
      );
    }
    throw new Error(`server still missing segments: ${result.missing.join(',')}`);
  }

  await setState(db, row.id, 'uploaded');
  await clearFailure(db, row.id, now().toISOString());
}

async function handleFailure(
  deps: SyncDeps,
  row: RecordingRow,
  error: unknown,
): Promise<void> {
  const { db, now, random } = deps;
  const message = error instanceof Error ? error.message : String(error);
  const at = now();

  // Back to queued so the next pass picks it up from wherever it stopped.
  const current = await db.first<{ state: string }>(
    `SELECT state FROM recordings WHERE id = ?`,
    [row.id]
  );
  if (current?.state === 'uploading') await setState(db, row.id, 'queued');

  await recordFailure(
    db,
    row.id,
    message,
    nextRetryAt(row.attempts, at, random),
    at.toISOString()
  );

  // Retries never stop, but after 24h the recording is surfaced as stuck (§4.3).
  const first = row.first_attempt_at ?? at.toISOString();
  if (shouldMarkStuck(first, at)) await markStuck(db, row.id);
}

/** A non-retryable API error should still be surfaced, never silently dropped. */
export function isPermanent(e: unknown): boolean {
  return e instanceof ApiError && !e.retryable;
}
