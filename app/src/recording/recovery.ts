import type { SqlDb } from '../db/adapter';
import {
  addSegment,
  finalizeRecording,
  listInterrupted,
  listSegments,
} from '../db/recordings';

export type DiskSegment = { name: string; uri: string; size: number | null };
export type ListDir = (dirUri: string) => DiskSegment[];

const SEGMENT_NAME = /^seg-(\d{4})\.m4a$/;

/**
 * Brings recordings left in `recording` state by a crash back to `recorded`.
 *
 * A segment file only reaches the recording's directory after a successful
 * move, so every file found there is complete and playable. Files present on
 * disk but missing from the database are adopted with an unknown duration
 * rather than discarded — losing audio is worse than losing a duration.
 */
export async function recoverInterruptedRecordings(
  db: SqlDb,
  listDir: ListDir
): Promise<string[]> {
  const recovered: string[] = [];
  for (const row of await listInterrupted(db)) {
    const known = new Set((await listSegments(db, row.id)).map((s) => s.seq));
    for (const file of listDir(row.file_path)) {
      const match = SEGMENT_NAME.exec(file.name);
      if (!match) continue;
      const seq = Number(match[1]);
      if (known.has(seq)) continue;
      await addSegment(db, {
        recording_id: row.id,
        seq,
        file_path: file.uri,
        duration_ms: null,
        size_bytes: file.size,
      });
    }
    await finalizeRecording(db, row.id);
    recovered.push(row.id);
  }
  return recovered;
}
