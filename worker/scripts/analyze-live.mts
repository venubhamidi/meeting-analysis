/**
 * Runs a stored transcript through the real analysis model and reports how the
 * verbatim-quote rule (invariant #7) held up.
 *
 *   SARVAM_API_KEY=... ANTHROPIC_API_KEY=... \
 *   TEST_PG_URL=postgresql://postgres:test@localhost:55432/meetings_test \
 *   npx tsx scripts/analyze-live.mts <transcript.json> <out.json>
 *
 * Input is the result.json produced by scripts/e2e.mts. Costs money.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import pg from 'pg';
import { migrate } from '../src/migrate.js';
import { analyzeMeeting } from '../src/pipeline/analyze.js';
import { createAnalyst } from '../src/pipeline/llm.js';
import type { Sql } from '../src/sql.js';

const [, , inPath, outPath] = process.argv;
const MEETING = '44444444-4444-4444-8444-444444444444';
const schema = `an_${Date.now()}`;

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

const segments = JSON.parse(readFileSync(inPath, 'utf8')).segments as any[];
await sql.query(
  `INSERT INTO meetings (id, user_id, created_at, status) VALUES ($1,'u1',now(),'transcribed')`,
  [MEETING]
);
for (const s of segments) {
  await sql.query(
    `INSERT INTO transcript_segments (meeting_id, seq, diarization_label, start_ms, end_ms, text_te)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [MEETING, s.seq, s.diarization_label, s.start_ms, s.end_ms, s.text_te]
  );
}
console.log(`transcript: ${segments.length} segments`);

const analyst = createAnalyst();
console.log(`model: ${analyst.model}`);
const t0 = Date.now();
const result = await analyzeMeeting(sql, analyst, MEETING);
console.log(`took ${((Date.now() - t0) / 1000).toFixed(0)}s`, result);

const { rows } = await sql.query<any>(`SELECT * FROM analyses WHERE meeting_id = $1`, [MEETING]);
writeFileSync(outPath, JSON.stringify(rows[0], null, 1));

// Re-verify independently of the stage: every stored quote must still be a
// literal substring of the segment it points at.
const byId = new Map(
  (await sql.query<any>(
    `SELECT id::text, text_te FROM transcript_segments WHERE meeting_id = $1`, [MEETING]
  )).rows.map((r: any) => [r.id, r.text_te])
);
let bad = 0;
for (const q of rows[0].quotes) {
  if (!String(byId.get(q.segment_id) ?? '').includes(q.text_te)) {
    bad++;
    console.log('NOT VERBATIM:', q.text_te.slice(0, 70));
  }
}
console.log(`stored quotes: ${rows[0].quotes.length}, non-verbatim after storage: ${bad}`);

await pool.end();
await admin.query(`DROP SCHEMA ${schema} CASCADE`);
await admin.end();
