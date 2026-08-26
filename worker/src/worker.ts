import { claim, complete, fail, reclaimExpired, type Job } from './jobs/queue.js';
import { SarvamClient } from './pipeline/sarvam.js';
import { transcribeMeeting, type Transcriber } from './pipeline/transcribe.js';
import type { Sql } from './sql.js';
import type { Storage } from './storage.js';

const IDLE_MS = 5_000;

export type Handlers = { transcribe(meetingId: string): Promise<unknown> };

export function handlers(sql: Sql, store: Storage, sarvam: Transcriber): Handlers {
  return {
    transcribe: (meetingId) => transcribeMeeting(sql, store, sarvam, meetingId),
  };
}

/**
 * Runs one poll cycle. Returns the number of jobs attempted, so the caller can
 * back off when the queue is empty.
 */
export async function tick(sql: Sql, h: Handlers): Promise<number> {
  await reclaimExpired(sql);
  const jobs = await claim(sql, ['transcribe'], 1);
  for (const job of jobs) await runJob(sql, h, job);
  return jobs.length;
}

async function runJob(sql: Sql, h: Handlers, job: Job): Promise<void> {
  try {
    if (!job.meeting_id) throw new Error(`job ${job.id} has no meeting_id`);
    await h[job.type as 'transcribe'](job.meeting_id);
    await complete(sql, job.id);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // A non-retryable provider error still consumes attempts rather than
    // failing instantly: the queue surfaces it in /admin/failed-jobs either
    // way, and a mis-labelled error should not discard a recording (§6.2).
    const status = await fail(sql, job, message);
    console.error(`job ${job.id} (${job.type}) failed -> ${status}: ${message}`);
  }
}

export async function runForever(
  sql: Sql,
  h: Handlers,
  signal?: AbortSignal
): Promise<void> {
  while (!signal?.aborted) {
    const worked = await tick(sql, h).catch((e) => {
      console.error('poll cycle failed:', e);
      return 0;
    });
    if (worked === 0) await sleep(IDLE_MS, signal);
  }
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });

// `npm run worker`
if (process.argv[1]?.endsWith('worker.ts')) {
  const { db } = await import('./db.js');
  const { storage } = await import('./storage.js');
  const key = process.env.SARVAM_API_KEY;
  if (!key) throw new Error('SARVAM_API_KEY is not set');

  const sql = db();
  const store = storage();
  const sarvam = new SarvamClient({ apiKey: key });
  const controller = new AbortController();
  process.on('SIGTERM', () => controller.abort());
  process.on('SIGINT', () => controller.abort());

  console.log('worker polling for jobs');
  await runForever(sql, handlers(sql, store, sarvam), controller.signal);
}
