import { Directory, File } from 'expo-file-system';
import type { SqlDb } from '../db/adapter';
import { sweepStrayRecorderFiles } from './paths';
import { recoverInterruptedRecordings, type DiskSegment } from './recovery';

function listDir(dirUri: string): DiskSegment[] {
  const dir = new Directory(dirUri);
  if (!dir.exists) return [];
  return dir
    .list()
    .filter((e): e is File => e instanceof File)
    .map((f) => ({ name: f.name, uri: f.uri, size: f.size }));
}

/** Startup recovery. Must run before any new recording starts. */
export async function runStartupRecovery(db: SqlDb): Promise<string[]> {
  const recovered = await recoverInterruptedRecordings(db, listDir);
  sweepStrayRecorderFiles();
  return recovered;
}
