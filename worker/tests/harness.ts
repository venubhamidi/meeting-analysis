import { PGlite } from '@electric-sql/pglite';
import type { Sql } from '../src/sql.js';
import { migrate } from '../src/migrate.js';
import { freshSchema, PG_URL } from './pg.js';

/**
 * A migrated, throwaway Postgres. Defaults to PGlite in-process (hermetic, no
 * daemon); with TEST_PG_URL set, the same suite runs against a real Postgres 16
 * container matching production. PGlite is single-connection, so multi-worker
 * contention lives in concurrency.test.ts, which requires the container.
 */
export async function freshDb(): Promise<Sql & { close(): Promise<void> }> {
  if (PG_URL) {
    const { pool, drop } = await freshSchema();
    const p = pool();
    const sql: Sql = {
      query: (text, params) => p.query(text, params as any[]) as any,
      exec: async (text) => {
        await p.query(text);
      },
    };
    await migrate(sql);
    return { ...sql, close: drop };
  }

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
