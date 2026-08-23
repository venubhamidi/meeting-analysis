import { PGlite } from '@electric-sql/pglite';
import type { Sql } from '../src/sql.js';
import { migrate } from '../src/migrate.js';

/**
 * A migrated, throwaway Postgres in-process. PGlite is single-connection, so
 * genuine multi-worker contention is covered by tests/live.test.ts instead.
 */
export async function freshDb(): Promise<Sql & { close(): Promise<void> }> {
  const pg = await PGlite.create();
  const sql: Sql = {
    query: (text, params) => pg.query(text, params as any[]) as any,
    exec: (text) => pg.exec(text).then(() => undefined),
  };
  await migrate(sql);
  return { ...sql, close: () => pg.close() };
}

export const MEETING = '11111111-1111-1111-1111-111111111111';
export const MEETING_2 = '22222222-2222-2222-2222-222222222222';

export async function insertMeeting(sql: Sql, id = MEETING): Promise<void> {
  await sql.query(
    `INSERT INTO meetings (id, user_id, created_at) VALUES ($1, 'u1', now())`,
    [id]
  );
}

/** Forces a job's lease or retry time into the past, standing in for elapsed time. */
export async function expire(sql: Sql, jobId: string): Promise<void> {
  await sql.query(`UPDATE jobs SET next_retry_at = now() - interval '1 second' WHERE id = $1`, [
    jobId,
  ]);
}
