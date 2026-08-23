import pg from 'pg';
import type { Sql } from './sql.js';

let pool: pg.Pool | null = null;

/**
 * Connects as the `meetings_app` role, whose search_path is set at the role
 * level to `meetings, extensions` — queries and migrations carry no schema
 * qualifiers, and cannot silently land in `public`.
 */
export function db(): Sql {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL is not set');
    pool = new pg.Pool({
      connectionString,
      ssl: { rejectUnauthorized: false },
      max: 5,
    });
  }
  const p = pool;
  return {
    query: (text, params) => p.query(text, params as any[]) as any,
    exec: async (text) => {
      await p.query(text);
    },
  };
}

export async function closeDb(): Promise<void> {
  await pool?.end();
  pool = null;
}
