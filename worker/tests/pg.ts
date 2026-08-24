import pg from 'pg';

/**
 * Container-backed Postgres for tests that PGlite cannot cover — anything
 * needing more than one connection. Set TEST_PG_URL to enable; see
 * `npm run test:pg`.
 */
export const PG_URL = process.env.TEST_PG_URL ?? null;
export const skipUnlessPg = { skip: PG_URL ? false : 'set TEST_PG_URL (see README)' };

let counter = 0;

/** An empty schema of its own, so tests never see each other's rows. */
export async function freshSchema(): Promise<{
  schema: string;
  pool(): pg.Pool;
  drop(): Promise<void>;
}> {
  if (!PG_URL) throw new Error('TEST_PG_URL is not set');
  const schema = `t${process.pid}_${++counter}`;
  const admin = new pg.Pool({ connectionString: PG_URL, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);

  const pools: pg.Pool[] = [];
  return {
    schema,
    // Each pool stands in for a separate worker process.
    pool() {
      const p = new pg.Pool({
        connectionString: PG_URL!,
        options: `-c search_path=${schema}`,
        max: 8,
      });
      pools.push(p);
      return p;
    },
    async drop() {
      await Promise.all(pools.map((p) => p.end()));
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    },
  };
}
