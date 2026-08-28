/**
 * Loads analysed sample meetings into a database, so the dashboard has real
 * rows to build against before the mobile app is uploading anything.
 *
 *   DATABASE_URL=... npx tsx scripts/seed.mts <schema> <slug>...
 *
 * Each slug reads /tmp/<slug>-result.json and /tmp/<slug>-analysis.json, the
 * outputs of e2e.mts and analyze-live.mts.
 *
 * Idempotent: a slug's meeting id is derived from its name, so re-running
 * replaces that meeting rather than accumulating duplicates. It writes only to
 * the schema named on the command line and touches no other.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';

const [, , schema, ...slugs] = process.argv;
if (!schema || !slugs.length) {
  console.error('usage: seed.mts <schema> <slug>...');
  process.exit(1);
}

/** A stable v4-shaped uuid per slug, so re-seeding overwrites in place. */
function idFor(slug: string): string {
  const h = createHash('sha256').update(`meeting:${slug}`).digest('hex');
  return [h.slice(0, 8), h.slice(8, 12), `4${h.slice(13, 16)}`,
    ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16) + h.slice(17, 20), h.slice(20, 32)].join('-');
}

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  options: `-c search_path=${schema},extensions`,
  max: 4,
});

for (const slug of slugs) {
  const result = JSON.parse(readFileSync(`/tmp/${slug}-result.json`, 'utf8'));
  const analysis = JSON.parse(readFileSync(`/tmp/${slug}-analysis.json`, 'utf8'));
  const segments: any[] = result.segments;
  const id = idFor(slug);

  const durationSeconds = Math.round(Math.max(...segments.map((s) => s.end_ms)) / 1000);
  // Sarvam's detected code is not in result.json; derive it from the script the
  // transcript is written in, the same way analyze.ts names the language.
  const text = segments.map((s) => s.text_te).join('');
  const language =
    /[ఀ-౿]/.test(text) ? 'te-IN' : /[ऀ-ॿ]/.test(text) ? 'hi-IN' : /[஀-௿]/.test(text) ? 'ta-IN' : null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Children first: analyses and transcript_segments both reference meetings.
    await client.query(`DELETE FROM analyses WHERE meeting_id = $1`, [id]);
    await client.query(`DELETE FROM transcript_segments WHERE meeting_id = $1`, [id]);
    await client.query(`DELETE FROM chunks WHERE meeting_id = $1`, [id]);
    await client.query(`DELETE FROM meetings WHERE id = $1`, [id]);

    await client.query(
      `INSERT INTO meetings
         (id, user_id, created_at, duration_seconds, status, language, language_probability, tags)
       VALUES ($1, 'sample', now(), $2, 'analyzed', $3, $4, $5)`,
      [id, durationSeconds, language, null, [slug, 'sample']]
    );

    for (const s of segments) {
      await client.query(
        `INSERT INTO transcript_segments
           (meeting_id, seq, diarization_label, start_ms, end_ms, text_te, low_confidence)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [id, s.seq, s.diarization_label, s.start_ms, s.end_ms, s.text_te, s.low_confidence ?? false]
      );
    }

    await client.query(
      `INSERT INTO analyses
         (meeting_id, telugu_summary, english_summary, quotes, sentiment,
          action_items, structured_facts, model)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        id,
        analysis.telugu_summary,
        analysis.english_summary,
        JSON.stringify(analysis.quotes ?? []),
        JSON.stringify(analysis.sentiment ?? {}),
        JSON.stringify(analysis.action_items ?? []),
        JSON.stringify(analysis.structured_facts ?? {}),
        analysis.model,
      ]
    );
    await client.query('COMMIT');
    console.log(
      `${slug.padEnd(11)} ${id}  ${language ?? '?'}  ${segments.length} segments, ` +
        `${(analysis.quotes ?? []).length} quotes, ${durationSeconds}s`
    );
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

await pool.end();
