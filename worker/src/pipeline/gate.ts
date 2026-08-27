/**
 * Declines to transcribe recordings that are not meetings — pocket recordings,
 * accidental starts, fragments. Pure, so the thresholds are testable.
 *
 * The audio is uploaded and kept regardless (§4.1). This only decides whether
 * to spend money on transcription, and a human can overrule it.
 *
 * Every rule fails open: when a signal is missing or ambiguous the recording is
 * transcribed. A skipped real meeting is a hole in the record that nobody
 * notices; a transcribed empty one costs about ₹28.
 */
export const MIN_DURATION_MS = 60_000;
/** Below this, the file is silence or handling noise rather than conversation. */
export const MIN_SPEECH_RATIO = 0.08;

export type GateInput = {
  durationMs: number | null;
  speechRatio: number | null;
  forced: boolean;
};

export type GateResult = { skip: false } | { skip: true; reason: string };

export function gate(input: GateInput): GateResult {
  if (input.forced) return { skip: false };

  if (input.durationMs != null && input.durationMs < MIN_DURATION_MS) {
    return {
      skip: true,
      reason: `shorter than ${MIN_DURATION_MS / 1000}s (${Math.round(input.durationMs / 1000)}s)`,
    };
  }
  if (input.speechRatio != null && input.speechRatio < MIN_SPEECH_RATIO) {
    return {
      skip: true,
      reason: `almost no speech detected (${Math.round(input.speechRatio * 100)}% non-silent)`,
    };
  }
  return { skip: false };
}
