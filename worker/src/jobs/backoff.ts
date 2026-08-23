/** Worker retry schedule (SPEC.md §6.2). Pure. */

const BASE_MS = 30_000;
const CAP_MS = 3_600_000;

/** 30s, 1m, 2m, 4m ... capped at 1h, with +/-20% jitter. */
export function retryDelayMs(attempts: number, random: () => number = Math.random): number {
  const exponential = BASE_MS * 2 ** Math.max(0, attempts - 1);
  const capped = Math.min(exponential, CAP_MS);
  return Math.round(capped * (0.8 + 0.4 * random()));
}
