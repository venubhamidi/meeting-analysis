import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Sql } from '../sql.js';
import type { Storage } from '../storage.js';
import { concatSegments } from './concat.js';
import type { SarvamEntry, SarvamResult } from './sarvam.js';

/**
 * Below this, a diarized entry is more likely a recogniser artefact than
 * speech, and is flagged for review rather than dropped (§6.1).
 */
const SHORT_ENTRY_MS = 300;

export type Transcriber = { transcribe(audioPath: string): Promise<SarvamResult> };

export type TranscribeResult = {
  segments: number;
  speakers: number;
  skipped: boolean;
};

/**
 * Turns a meeting's audio into transcript_segments.
 *
 * Idempotent by design (§6.1): if segments already exist the whole stage is a
 * no-op, so a retry after a crash between writing rows and marking the job done
 * never re-pays Sarvam and never duplicates rows.
 */
export async function transcribeMeeting(
  sql: Sql,
  store: Storage,
  sarvam: Transcriber,
  meetingId: string
): Promise<TranscribeResult> {
  const existing = await sql.query<{ n: string }>(
    `SELECT count(*) AS n FROM transcript_segments WHERE meeting_id = $1`,
    [meetingId]
  );
  if (Number(existing.rows[0].n) > 0) {
    return { segments: Number(existing.rows[0].n), speakers: 0, skipped: true };
  }

  await sql.query(`UPDATE meetings SET status = 'transcribing' WHERE id = $1`, [meetingId]);
  const concat = await concatSegments(sql, store, meetingId);

  const dir = await mkdtemp(join(tmpdir(), `stt-${meetingId}-`));
  try {
    const audio = join(dir, 'audio.m4a');
    await store.download(concat.key, audio);
    const result = await sarvam.transcribe(audio);
    const rows = toSegments(result);
    if (rows.length === 0) {
      throw new Error(`sarvam returned no usable transcript for ${meetingId}`);
    }

    for (const row of rows) {
      await sql.query(
        `INSERT INTO transcript_segments
           (meeting_id, seq, diarization_label, start_ms, end_ms, text_te, words, low_confidence)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (meeting_id, seq) DO NOTHING`,
        [
          meetingId,
          row.seq,
          row.label,
          row.startMs,
          row.endMs,
          row.text,
          JSON.stringify(row.words),
          row.lowConfidence,
        ]
      );
    }

    await sql.query(`UPDATE meetings SET status = 'transcribed' WHERE id = $1`, [meetingId]);
    return {
      segments: rows.length,
      speakers: new Set(rows.map((r) => r.label)).size,
      skipped: false,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

type Row = {
  seq: number;
  label: string;
  startMs: number;
  endMs: number;
  text: string;
  words: unknown;
  lowConfidence: boolean;
};

/**
 * Maps Sarvam's diarized entries onto transcript_segments.
 *
 * Sarvam's `timestamps.words` is misleadingly named: it holds chunk-level
 * spans (a sentence or phrase), not individual words — verified against the
 * live API. So `words` here stores the chunks that overlap each entry, and
 * quote playback resolves to the sentence containing the quote rather than the
 * word. SPEC.md §1/§4.4 assume word-level precision and overstate what the
 * provider offers.
 */
export function toSegments(result: SarvamResult): Row[] {
  const entries = result.diarized_transcript?.entries ?? [];

  if (entries.length === 0) {
    // No diarization came back; keep the transcript rather than lose it.
    const text = result.transcript?.trim();
    if (!text) return [];
    return [
      {
        seq: 0,
        label: 'Speaker 1',
        startMs: 0,
        endMs: 0,
        text,
        words: chunksOf(result),
        lowConfidence: true,
      },
    ];
  }

  const chunks = chunksOf(result);
  const speakers = new Map<string, string>();
  return entries
    .filter((e) => e.transcript?.trim())
    .map((entry, seq) => {
      const startMs = toMs(entry.start_time_seconds);
      const endMs = toMs(entry.end_time_seconds);
      return {
        seq,
        label: speakerLabel(entry, speakers),
        startMs,
        endMs,
        text: entry.transcript.trim(),
        words: chunks.filter((c) => c.endMs > startMs && c.startMs < endMs),
        lowConfidence: endMs - startMs < SHORT_ENTRY_MS,
      };
    });
}

/**
 * Numbers speakers by order of first appearance.
 *
 * Sarvam's speaker_id is neither zero-based nor contiguous — a two-person
 * conversation came back as ids 1 and 2 in live testing — so using it directly
 * would label a two-speaker meeting "Speaker 2" and "Speaker 3". The mapping is
 * meeting-scoped, which is all §7 requires.
 */
function speakerLabel(entry: SarvamEntry, seen: Map<string, string>): string {
  const id = String(entry.speaker_id);
  let label = seen.get(id);
  if (!label) {
    label = `Speaker ${seen.size + 1}`;
    seen.set(id, label);
  }
  return label;
}

function chunksOf(result: SarvamResult): { text: string; startMs: number; endMs: number }[] {
  const t = result.timestamps;
  if (!t?.words) return [];
  return t.words.map((text, i) => ({
    text,
    startMs: toMs(t.start_time_seconds?.[i]),
    endMs: toMs(t.end_time_seconds?.[i]),
  }));
}

function toMs(seconds: number | undefined): number {
  return Number.isFinite(seconds) ? Math.round((seconds as number) * 1000) : 0;
}
