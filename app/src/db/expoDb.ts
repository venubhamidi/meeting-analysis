import * as SQLite from 'expo-sqlite';
import type { SqlDb, SqlParams } from './adapter';
import { migrate } from './migrate';

let db: SqlDb | null = null;

function wrap(native: SQLite.SQLiteDatabase): SqlDb {
  return {
    exec: (sql) => native.execAsync(sql),
    run: async (sql, params = []) => {
      await native.runAsync(sql, params);
    },
    all: (sql, params = []) => native.getAllAsync(sql, params),
    first: (sql, params = []) => native.getFirstAsync(sql, params),
  };
}

/** Opens the on-device database and migrates it. Idempotent. */
export async function openDb(): Promise<SqlDb> {
  if (db) return db;
  const native = await SQLite.openDatabaseAsync('meetings.db');
  await native.execAsync('PRAGMA journal_mode = WAL');
  const wrapped = wrap(native);
  await migrate(wrapped);
  db = wrapped;
  return db;
}
