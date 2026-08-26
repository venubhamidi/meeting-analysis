/**
 * Production entrypoint: the HTTP API and the job poll loop in one process.
 *
 * They are separated in the code (server.ts / worker.ts) and could be split
 * into two Railway services later. At ~10 meetings a day one process is
 * enough: ffmpeg runs in a child process and Sarvam calls are async, so
 * neither blocks the API. The trade-off is that a crash in the pipeline takes
 * the API down with it — acceptable while a single user is uploading, and the
 * reason /health exists for Railway to restart on.
 */
import { createApp } from './api/app.js';
import { closeDb, db } from './db.js';
import { migrate } from './migrate.js';
import { createAnalyst } from './pipeline/llm.js';
import { SarvamClient } from './pipeline/sarvam.js';
import { storage } from './storage.js';
import { handlers, runForever } from './worker.js';

const port = Number(process.env.PORT ?? 8080);
const sql = db();

// Idempotent, so a redeploy that changes nothing is a no-op.
const applied = await migrate(sql);
console.log(applied.length ? `migrations applied: ${applied.join(', ')}` : 'schema up to date');

const store = storage();
const server = createApp(sql, store).listen(port, () => {
  console.log(`api listening on ${port}`);
});

const key = process.env.SARVAM_API_KEY;
const controller = new AbortController();

if (key) {
  console.log('worker polling for jobs');
  const analyst = process.env.ANTHROPIC_API_KEY ? createAnalyst() : undefined;
  if (!analyst) console.warn('ANTHROPIC_API_KEY is not set — analyze jobs will queue unprocessed');
  void runForever(
    sql,
    handlers(sql, store, new SarvamClient({ apiKey: key }), analyst),
    controller.signal
  );
} else {
  // The API still serves uploads; jobs simply queue until a key is configured.
  console.warn('SARVAM_API_KEY is not set — transcription jobs will queue unprocessed');
}

async function shutdown(signal: string) {
  console.log(`${signal} received, shutting down`);
  controller.abort();
  await new Promise((r) => server.close(r));
  await closeDb();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
