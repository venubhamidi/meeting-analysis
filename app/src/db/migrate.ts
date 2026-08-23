import { MIGRATIONS } from './migrations';
import type { SqlDb } from './adapter';

/** Applies any migrations the database has not seen yet. Safe to re-run. */
export async function migrate(db: SqlDb): Promise<number> {
  const row = await db.first<{ user_version: number }>('PRAGMA user_version');
  const current = row?.user_version ?? 0;
  for (let i = current; i < MIGRATIONS.length; i++) {
    await db.exec(MIGRATIONS[i]);
    // PRAGMA does not accept bound parameters.
    await db.exec(`PRAGMA user_version = ${i + 1}`);
  }
  return MIGRATIONS.length;
}
