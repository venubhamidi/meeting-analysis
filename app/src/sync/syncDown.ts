import type { SqlDb } from '../db/adapter';
import { getRecording, setState, type RecordingRow } from '../db/recordings';
import type { Api, TranscriptSegment } from './api';
import type { RecordingState } from '../recording/states';

/**
 * Pulls results down so meetings can be read with no connectivity (§4.4).
 *
 * The server's status is authoritative for pipeline progress; the local state
 * machine is advanced to match, one legal step at a time, so a jump the client
 * has not seen cannot skip states.
 */
const SERVER_STATE: Record<string, RecordingState> = {
  uploaded: 'uploaded',
  transcribing: 'transcribing',
  transcribed: 'analyzed',
  analyzing: 'analyzed',
  analyzed: 'analyzed',
};

/** The path from one state to another, so no transition is skipped. */
const ORDER: RecordingState[] = [
  'uploaded',
  'transcribing',
  'analyzed',
  'synced',
];

export type SyncDownResult = {
  updated: string[];
  transcripts: number;
};

export async function syncDownOnce(
  db: SqlDb,
  api: Api
): Promise<SyncDownResult> {
  const out: SyncDownResult = { updated: [], transcripts: 0 };

  // Anything the server is still working on, or has finished but we have not
  // stored yet.
  const rows = await db.all<RecordingRow>(
    `SELECT * FROM recordings
      WHERE state IN ('uploaded', 'transcribing', 'analyzed')
      ORDER BY created_at`
  );

  for (const row of rows) {
    let detail;
    try {
      detail = await api.getRecording(row.id);
    } catch {
      // A recording we cannot reach is left exactly as it is; the next pass
      // tries again. Nothing is lost by skipping it.
      continue;
    }

    if (detail.transcript.length > 0) {
      await storeTranscript(db, row.id, detail.transcript);
      out.transcripts++;
    }

    const target = SERVER_STATE[detail.status];
    if (target && target !== row.state) {
      await advance(db, row.id, row.state, target);
      out.updated.push(row.id);
    }
  }
  return out;
}

/** Walks the state machine forward one legal step at a time. */
async function advance(
  db: SqlDb,
  id: string,
  from: RecordingState,
  to: RecordingState
): Promise<void> {
  const start = ORDER.indexOf(from);
  const end = ORDER.indexOf(to);
  if (start < 0 || end < 0 || end <= start) return;
  for (let i = start; i < end; i++) {
    await setState(db, id, ORDER[i + 1]);
  }
}

export async function storeTranscript(
  db: SqlDb,
  recordingId: string,
  transcript: TranscriptSegment[]
): Promise<void> {
  await db.run(
    `INSERT INTO transcripts_local (recording_id, transcript_json)
     VALUES (?, ?)
     ON CONFLICT (recording_id) DO UPDATE SET transcript_json = excluded.transcript_json`,
    [recordingId, JSON.stringify(transcript)]
  );
}

export async function localTranscript(
  db: SqlDb,
  recordingId: string
): Promise<TranscriptSegment[]> {
  const row = await db.first<{ transcript_json: string | null }>(
    `SELECT transcript_json FROM transcripts_local WHERE recording_id = ?`,
    [recordingId]
  );
  if (!row?.transcript_json) return [];
  try {
    return JSON.parse(row.transcript_json) as TranscriptSegment[];
  } catch {
    return [];
  }
}
