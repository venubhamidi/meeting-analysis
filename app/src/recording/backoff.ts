/** Retry scheduling (SPEC.md §4.3). Pure — no I/O, no clock of its own. */

/** 30s, 2m, 10m, 30m, then capped at 1h. */
const SCHEDULE_MS = [30_000, 120_000, 600_000, 1_800_000];
const CAP_MS = 3_600_000;
const STUCK_AFTER_MS = 24 * 60 * 60 * 1000;

/** ±20% jitter so retries from many recordings do not align. */
export function backoffMs(attempts: number, random: () => number = Math.random): number {
  const base = SCHEDULE_MS[Math.min(attempts, SCHEDULE_MS.length - 1)] ?? CAP_MS;
  const capped = Math.min(attempts >= SCHEDULE_MS.length ? CAP_MS : base, CAP_MS);
  return Math.round(capped * (0.8 + 0.4 * random()));
}

export function nextRetryAt(
  attempts: number,
  now: Date,
  random: () => number = Math.random
): string {
  return new Date(now.getTime() + backoffMs(attempts, random)).toISOString();
}

/**
 * Retries never stop; after 24h of trying, the recording is flagged `stuck` so
 * the UI can surface it. `firstAttemptAt` is null before the first attempt.
 */
export function shouldMarkStuck(firstAttemptAt: string | null, now: Date): boolean {
  if (!firstAttemptAt) return false;
  return now.getTime() - new Date(firstAttemptAt).getTime() >= STUCK_AFTER_MS;
}
