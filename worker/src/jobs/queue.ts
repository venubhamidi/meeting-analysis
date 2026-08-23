import type { Sql } from '../sql.js';
import { retryDelayMs } from './backoff.js';

export type JobType =
  | 'transcribe'
  | 'analyze'
  | 'embed'
  | 'rollup_daily'
  | 'rollup_weekly'
  | 'rollup_monthly';

export type JobStatus = 'pending' | 'running' | 'done' | 'failed';

export type Job = {
  id: string;
  meeting_id: string | null;
  type: JobType;
  payload: Record<string, unknown> | null;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  next_retry_at: string;
  last_error: string | null;
};

/** How long a claimed job may run before another worker may take it over. */
export const LEASE_MS = 30 * 60_000;

/**
 * Invariant #3: one job per meeting per stage. A duplicate enqueue — a retried
 * upload-complete call, say — is a no-op rather than a second transcription
 * charge.
 */
export async function enqueue(
  sql: Sql,
  meetingId: string,
  type: JobType,
  payload: Record<string, unknown> | null = null
): Promise<void> {
  await sql.query(
    `INSERT INTO jobs (meeting_id, type, payload) VALUES ($1, $2, $3)
     ON CONFLICT (meeting_id, type) DO NOTHING`,
    [meetingId, type, payload]
  );
}

/**
 * Claims due jobs for this worker. `SKIP LOCKED` lets several workers poll the
 * same table without blocking or handing the same job to two of them.
 *
 * While a job is `running`, `next_retry_at` holds its lease deadline; see
 * `reclaimExpired`.
 */
export async function claim(sql: Sql, types: JobType[], limit = 1): Promise<Job[]> {
  const { rows } = await sql.query<Job>(
    `UPDATE jobs SET status = 'running',
                     next_retry_at = now() + make_interval(secs => $3)
      WHERE id IN (
        SELECT id FROM jobs
         WHERE status = 'pending'
           AND next_retry_at <= now()
           AND type = ANY($1)
         ORDER BY created_at
         LIMIT $2
         FOR UPDATE SKIP LOCKED
      )
      RETURNING *`,
    [types, limit, LEASE_MS / 1000]
  );
  return rows;
}

export async function complete(sql: Sql, jobId: string): Promise<void> {
  await sql.query(`UPDATE jobs SET status = 'done', last_error = NULL WHERE id = $1`, [
    jobId,
  ]);
}

/**
 * Records a failed attempt. Below `max_attempts` the job goes back to `pending`
 * with a backoff; at the limit it becomes `failed` — visible in
 * /admin/failed-jobs for a human to decide, never silently dropped (§6.2).
 */
export async function fail(
  sql: Sql,
  job: Pick<Job, 'id' | 'attempts' | 'max_attempts'>,
  error: string,
  random?: () => number
): Promise<JobStatus> {
  const attempts = job.attempts + 1;
  const exhausted = attempts >= job.max_attempts;
  await sql.query(
    `UPDATE jobs
        SET attempts = $2,
            status = $3,
            last_error = $4,
            next_retry_at = now() + make_interval(secs => $5)
      WHERE id = $1`,
    [
      job.id,
      attempts,
      exhausted ? 'failed' : 'pending',
      error.slice(0, 2000),
      exhausted ? 0 : retryDelayMs(attempts, random) / 1000,
    ]
  );
  return exhausted ? 'failed' : 'pending';
}

/**
 * Returns jobs whose worker died mid-run to the queue. The attempt is counted,
 * so a job that reliably kills its worker eventually lands in `failed` instead
 * of looping forever.
 */
export async function reclaimExpired(sql: Sql): Promise<number> {
  const { rows } = await sql.query<{ id: string }>(
    `UPDATE jobs
        SET status = CASE WHEN attempts + 1 >= max_attempts THEN 'failed' ELSE 'pending' END,
            attempts = attempts + 1,
            last_error = 'worker lease expired',
            next_retry_at = now()
      WHERE status = 'running' AND next_retry_at <= now()
      RETURNING id`
  );
  return rows.length;
}

export async function failedJobs(sql: Sql): Promise<Job[]> {
  const { rows } = await sql.query<Job>(
    `SELECT * FROM jobs WHERE status = 'failed' ORDER BY id`
  );
  return rows;
}
