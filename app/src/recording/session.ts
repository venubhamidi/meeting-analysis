import * as Crypto from 'expo-crypto';
import { File } from 'expo-file-system';
import type { AudioRecorder, RecordingOptions } from 'expo-audio';
import { RecordingPresets } from 'expo-audio';

import type { SqlDb } from '../db/adapter';
import {
  addSegment,
  createRecording,
  finalizeRecording,
} from '../db/recordings';
import { recordingDir, segmentFileName } from './paths';

/** ~60s segments (SPEC.md §4.1): a crash costs at most one segment. */
export const SEGMENT_MS = 60_000;

/** Mono voice AAC — ~14 MB for 30 minutes. */
export const RECORDING_OPTIONS: RecordingOptions = {
  ...RecordingPresets.HIGH_QUALITY,
  numberOfChannels: 1,
  bitRate: 64_000,
  directory: 'document',
};

/**
 * Drives segment-safe recording with two recorders: one captures while the
 * other sits prepared, so a rotation costs only the duration of `stop()`.
 */
export class RecordingSession {
  private active = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private recordingId: string | null = null;
  private dirUri: string | null = null;
  private seq = 0;
  private committedMsTotal = 0;
  private rotating = false;

  constructor(
    private db: SqlDb,
    private recorders: [AudioRecorder, AudioRecorder],
    private onChange: () => void = () => {}
  ) {}

  get currentId(): string | null {
    return this.recordingId;
  }

  get committedSegments(): number {
    return this.seq;
  }

  /** Total audio already safe on disk, in milliseconds. */
  get committedMs(): number {
    return this.committedMsTotal;
  }

  get activeRecorder(): AudioRecorder {
    return this.recorders[this.active];
  }

  async start(): Promise<string> {
    if (this.recordingId) throw new Error('a recording is already in progress');
    const id = Crypto.randomUUID();
    const dir = recordingDir(id);
    // The row exists before the first audio byte, so a crash is always recoverable.
    await createRecording(this.db, id, new Date().toISOString(), dir.uri);
    this.recordingId = id;
    this.dirUri = dir.uri;
    this.seq = 0;
    this.committedMsTotal = 0;
    this.active = 0;

    await this.recorders[0].prepareToRecordAsync(RECORDING_OPTIONS);
    this.recorders[0].record();
    await this.recorders[1].prepareToRecordAsync(RECORDING_OPTIONS);

    this.timer = setInterval(() => void this.rotate(), SEGMENT_MS);
    this.onChange();
    return id;
  }

  private async rotate(): Promise<void> {
    if (this.rotating || !this.recordingId) return;
    this.rotating = true;
    try {
      const current = this.recorders[this.active];
      const next = this.recorders[1 - this.active];
      const durationMs = current.getStatus().durationMillis;
      const uri = current.uri;

      await current.stop();
      next.record();
      this.active = 1 - this.active;

      await this.commit(uri, durationMs);
      await current.prepareToRecordAsync(RECORDING_OPTIONS);
    } finally {
      this.rotating = false;
    }
  }

  /**
   * Move the file first, then record it. A crash between the two leaves a file
   * that recovery adopts; the reverse order would leave a row pointing at
   * nothing.
   */
  private async commit(uri: string | null, durationMs: number): Promise<void> {
    if (!uri || !this.dirUri || !this.recordingId) return;
    const src = new File(uri);
    if (!src.exists) return;

    const dest = new File(this.dirUri, segmentFileName(this.seq));
    await src.move(dest);
    await addSegment(this.db, {
      recording_id: this.recordingId,
      seq: this.seq,
      file_path: dest.uri,
      duration_ms: durationMs,
      size_bytes: dest.size,
    });
    this.seq += 1;
    this.committedMsTotal += durationMs;
    this.onChange();
  }

  async stop(): Promise<string | null> {
    const id = this.recordingId;
    if (!id) return null;

    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    while (this.rotating) await new Promise((r) => setTimeout(r, 20));

    const current = this.recorders[this.active];
    const durationMs = current.getStatus().durationMillis;
    const uri = current.uri;
    await current.stop();
    await this.commit(uri, durationMs);

    // Discard the file belonging to the recorder that stayed prepared but idle.
    const idleUri = this.recorders[1 - this.active].uri;
    if (idleUri) {
      const idle = new File(idleUri);
      if (idle.exists) idle.delete();
    }

    await finalizeRecording(this.db, id);
    this.recordingId = null;
    this.dirUri = null;
    this.onChange();
    return id;
  }
}
