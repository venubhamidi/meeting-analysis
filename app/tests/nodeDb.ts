import { DatabaseSync } from 'node:sqlite';
import type { SqlDb, SqlParams } from '../src/db/adapter';
import { migrate } from '../src/db/migrate';

/** In-memory SqlDb backed by node:sqlite, so tests exercise the real SQL. */
export async function testDb(): Promise<SqlDb> {
  const native = new DatabaseSync(':memory:');
  const db: SqlDb = {
    exec: async (sql) => native.exec(sql),
    run: async (sql, params: SqlParams = []) => {
      native.prepare(sql).run(...params);
    },
    all: async (sql, params: SqlParams = []) =>
      native.prepare(sql).all(...params) as any,
    first: async (sql, params: SqlParams = []) =>
      (native.prepare(sql).get(...params) as any) ?? null,
  };
  await migrate(db);
  return db;
}
