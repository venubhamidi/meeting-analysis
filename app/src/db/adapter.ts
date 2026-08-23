/**
 * The subset of a SQLite driver this app uses. Implemented by expo-sqlite on
 * device and by node:sqlite in tests, so schema and repository logic are
 * exercised for real without a simulator.
 */
export type SqlParams = (string | number | null)[];

export interface SqlDb {
  exec(sql: string): Promise<void>;
  run(sql: string, params?: SqlParams): Promise<void>;
  all<T>(sql: string, params?: SqlParams): Promise<T[]>;
  first<T>(sql: string, params?: SqlParams): Promise<T | null>;
}
