import { Directory, File, Paths } from 'expo-file-system';

/** Segments live in the document directory so the OS never reclaims them. */
export function recordingsRoot(): Directory {
  const dir = new Directory(Paths.document, 'recordings');
  if (!dir.exists) dir.create({ intermediates: true });
  return dir;
}

export function recordingDir(id: string): Directory {
  const dir = new Directory(recordingsRoot(), id);
  if (!dir.exists) dir.create({ intermediates: true });
  return dir;
}

export function segmentFileName(seq: number): string {
  return `seg-${String(seq).padStart(4, '0')}.m4a`;
}

/**
 * expo-audio picks its own filename and writes it to the document root; we move
 * finished segments out of there. Anything left behind belongs to a recorder
 * that was prepared but never used, or to a process killed mid-segment (whose
 * file has no moov atom and is unplayable anyway). Only call this at startup,
 * with no recording in flight.
 */
export function sweepStrayRecorderFiles(): void {
  for (const entry of new Directory(Paths.document).list()) {
    if (entry instanceof File && entry.extension === '.m4a') entry.delete();
  }
}
