/**
 * Sync state machine (SPEC.md §4.3). Pure — no I/O, no React, no native.
 *
 * `recording` is an addition to the spec's list: the row is written at record
 * time (§4.1) and must be distinguishable from a finalized recording so crash
 * recovery can find it.
 */
export const STATES = [
  'recording',
  'recorded',
  'queued',
  'uploading',
  'uploaded',
  'transcribing',
  'analyzed',
  'synced',
  'stuck',
] as const;

export type RecordingState = (typeof STATES)[number];

const ALLOWED: Record<RecordingState, RecordingState[]> = {
  recording: ['recorded'],
  recorded: ['queued'],
  queued: ['uploading'],
  uploading: ['uploaded', 'queued'], // back to queued on a failed attempt
  uploaded: ['transcribing'],
  transcribing: ['analyzed', 'uploaded'], // back to uploaded to retry transcription
  analyzed: ['synced'],
  synced: [],
  stuck: ['queued'], // manual retry
};

/** States from which the pipeline can still make progress on its own. */
const IN_FLIGHT: RecordingState[] = [
  'recorded',
  'queued',
  'uploading',
  'uploaded',
  'transcribing',
  'analyzed',
];

export function canTransition(from: RecordingState, to: RecordingState): boolean {
  if (to === 'stuck') return IN_FLIGHT.includes(from);
  return ALLOWED[from].includes(to);
}

/** Throws rather than silently ignoring an illegal transition (§1: no silent loss). */
export function transition(from: RecordingState, to: RecordingState): RecordingState {
  if (!canTransition(from, to)) {
    throw new Error(`illegal state transition: ${from} -> ${to}`);
  }
  return to;
}

export function isInFlight(state: RecordingState): boolean {
  return IN_FLIGHT.includes(state);
}

/**
 * Invariant #10: local audio may only be deleted once the server has confirmed
 * transcription — not merely upload. Phase 1 has no server, so this is always
 * false; the rule exists before any code could violate it.
 */
export function canDeleteLocalAudio(state: RecordingState): boolean {
  return state === 'analyzed' || state === 'synced';
}
