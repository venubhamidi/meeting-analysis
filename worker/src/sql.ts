/**
 * The query surface shared by `pg` (production) and PGlite (tests), so the
 * queue and migrations run against real Postgres in both.
 */
export interface Sql {
  /** Single statement, optionally parameterised. */
  query<T = Record<string, unknown>>(
    text: string,
    params?: unknown[]
  ): Promise<{ rows: T[] }>;

  /**
   * Multiple statements, no parameters — migration files. Kept separate
   * because the extended protocol that carries parameters accepts only one
   * statement per call.
   */
  exec(text: string): Promise<void>;
}
