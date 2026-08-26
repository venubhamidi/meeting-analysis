/**
 * Drives one real recording through the whole pipeline — upload API, storage,
 * concat, Sarvam, Postgres — and dumps the result as JSON.
 *
 * This is the harness for the SPEC.md §11.2 quality gate: point it at a folder
 * of the client's real 60-second segments and read the transcript before any
 * downstream work is built.
 *
 *   docker start mi-pg-test mi-minio
 *   SARVAM_API_KEY=... \
 *   TEST_PG_URL=postgresql://postgres:test@localhost:55432/meetings_test \
 *   TEST_S3_ENDPOINT=http://localhost:59000 \
 *   npx tsx scripts/e2e.mts <segment-dir> <out.json>
 *
 * It creates and drops its own Postgres schema and MinIO bucket, so it never
 * touches real data. Costs money: Sarvam bills per minute of audio.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { migrate } from '../src/migrate.js';
import { createApp } from '../src/api/app.js';
import { storage } from '../src/storage.js';
import { SarvamClient } from '../src/pipeline/sarvam.js';
import { handlers, tick } from '../src/worker.js';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import type { Sql } from '../src/sql.js';
import type { AddressInfo } from 'node:net';

const SEG_DIR = process.argv[2];
const MEETING = '33333333-3333-4333-8333-333333333333';
const TOKEN = 'e2e-token';
const schema = `e2e_${Date.now()}`;

const admin = new pg.Pool({ connectionString: process.env.TEST_PG_URL, max: 2 });
await admin.query(`CREATE SCHEMA ${schema}`);
const pool = new pg.Pool({
  connectionString: process.env.TEST_PG_URL,
  options: `-c search_path=${schema}`,
  max: 4,
});
const sql: Sql = {
  query: (t, p) => pool.query(t, p as any[]) as any,
  exec: async (t) => { await pool.query(t); },
};
await migrate(sql);

const bucket = `e2e-${Date.now()}`;
const s3env = {
  S3_ENDPOINT: process.env.TEST_S3_ENDPOINT, R2_BUCKET: bucket,
  R2_ACCESS_KEY_ID: 'minioadmin', R2_SECRET_ACCESS_KEY: 'minioadmin',
} as NodeJS.ProcessEnv;
await new S3Client({
  region: 'auto', endpoint: process.env.TEST_S3_ENDPOINT, forcePathStyle: true,
  credentials: { accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' },
}).send(new CreateBucketCommand({ Bucket: bucket }));
const store = storage(s3env);

const server = createApp(sql, store, { DEVICE_TOKEN: TOKEN, DEVICE_USER_ID: 'u1' } as any).listen(0);
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const api = (path: string, init: RequestInit = {}) =>
  fetch(base + path, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) } });

const files = readdirSync(SEG_DIR).filter((f) => f.endsWith('.m4a')).sort();
console.log(`uploading ${files.length} segments as the app would`);

const t0 = Date.now();
const init = await (await api(`/recordings/${MEETING}/upload-init`, {
  method: 'POST',
  body: JSON.stringify({ createdAt: new Date().toISOString(), segments: files.map((_, i) => ({ seq: i })) }),
})).json() as any;

for (const seg of init.segments) {
  const body = readFileSync(join(SEG_DIR, files[seg.seq]));
  const put = await fetch(seg.url, { method: 'PUT', body: new Uint8Array(body), headers: { 'content-type': 'audio/mp4' } });
  if (!put.ok) throw new Error(`segment ${seg.seq} PUT ${put.status}`);
  const ok = await api(`/recordings/${MEETING}/segments/${seg.seq}/uploaded`, { method: 'POST' });
  if (!ok.ok) throw new Error(`segment ${seg.seq} confirm ${ok.status}`);
}
const done = await api(`/recordings/${MEETING}/upload-complete`, {
  method: 'POST', body: JSON.stringify({ segmentsTotal: files.length, durationSeconds: 1162 }),
});
console.log(`upload-complete: ${done.status} ${JSON.stringify(await done.json())}  (${((Date.now()-t0)/1000).toFixed(1)}s)`);

console.log('running worker...');
const t1 = Date.now();
const sarvam = new SarvamClient({ apiKey: process.env.SARVAM_API_KEY!, pollIntervalMs: 5_000 });
await tick(sql, handlers(sql, store, sarvam));
console.log(`worker tick finished in ${((Date.now()-t1)/1000).toFixed(0)}s`);

const meeting = await sql.query<any>(`SELECT status, duration_seconds, audio_size_bytes FROM meetings WHERE id=$1`, [MEETING]);
const jobs = await sql.query<any>(`SELECT status, attempts, last_error FROM jobs`);
const segs = await sql.query<any>(`SELECT seq, diarization_label, start_ms, end_ms, text_te, low_confidence FROM transcript_segments WHERE meeting_id=$1 ORDER BY seq`, [MEETING]);
console.log('meeting:', meeting.rows[0]);
console.log('job:', jobs.rows[0]);
console.log(`transcript segments: ${segs.rows.length}`);

const out = { meeting: meeting.rows[0], job: jobs.rows[0], segments: segs.rows };
const { writeFileSync } = await import('node:fs');
writeFileSync(process.argv[3], JSON.stringify(out, null, 1));
await new Promise((r) => server.close(r));
await pool.end();
await admin.query(`DROP SCHEMA ${schema} CASCADE`);
await admin.end();
