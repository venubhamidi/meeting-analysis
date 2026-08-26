import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../src/migrate.js';
import type { Sql } from '../src/sql.js';
import { freshDb, insertMeeting, MEETING } from './harness.js';

test('migrations apply once and are safe to re-run', async () => {
  const pg = await PGlite.create();
  const sql: Sql = {
    query: (t, p) => pg.query(t, p as any[]) as any,
    exec: (t) => pg.exec(t).then(() => undefined),
  };

  const first = await migrate(sql);
  const second = await migrate(sql);

  assert.deepEqual(first, ['001_phase2.sql', '002_segments.sql']);
  assert.deepEqual(second, []);
  await pg.close();
});

test('transcript segments get a searchable tsvector for free', async () => {
  const db = await freshDb();
  await insertMeeting(db);
  await db.query(
    `INSERT INTO transcript_segments (meeting_id, seq, start_ms, end_ms, text_te)
     VALUES ($1, 0, 0, 5000, 'water supply problem in the village')`,
    [MEETING]
  );
  const { rows } = await db.query<{ n: string }>(
    `SELECT count(*) AS n FROM transcript_segments
      WHERE tsv @@ to_tsquery('simple', 'water')`
  );
  assert.equal(Number(rows[0].n), 1);
  await db.close();
});

test('invariant 4: a retried transcription cannot double-insert a segment', async () => {
  const db = await freshDb();
  await insertMeeting(db);
  const insert = () =>
    db.query(
      `INSERT INTO transcript_segments (meeting_id, seq, start_ms, end_ms, text_te)
       VALUES ($1, 0, 0, 5000, 'first pass')`,
      [MEETING]
    );
  await insert();
  await assert.rejects(insert, /duplicate key|unique/i);

  const { rows } = await db.query<{ n: string }>(
    `SELECT count(*) AS n FROM transcript_segments WHERE meeting_id = $1`,
    [MEETING]
  );
  assert.equal(Number(rows[0].n), 1);
  await db.close();
});
