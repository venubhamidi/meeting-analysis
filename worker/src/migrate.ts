import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Sql } from './sql.js';

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

/** Applies every .sql file not yet recorded, in filename order. Safe to re-run. */
export async function migrate(sql: Sql, dir = DIR): Promise<string[]> {
  await sql.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ DEFAULT now()
    )
  `);
  const done = new Set(
    (await sql.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map(
      (r) => r.name
    )
  );

  const applied: string[] = [];
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    if (done.has(name)) continue;
    await sql.exec(readFileSync(join(dir, name), 'utf8'));
    await sql.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
    applied.push(name);
  }
  return applied;
}

// `npm run migrate`
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { db, closeDb } = await import('./db.js');
  const applied = await migrate(db());
  console.log(applied.length ? `applied: ${applied.join(', ')}` : 'already up to date');
  await closeDb();
}
