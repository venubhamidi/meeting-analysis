import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Sql } from '../src/sql.js';
import { migrate } from '../src/migrate.js';
import { claim, complete, enqueue, fail, type Job } from '../src/jobs/queue.js';
import { freshSchema, skipUnlessPg } from './pg.js';

/**
 * These need real concurrent connections, so they only run against the
 * Postgres 16 container (`npm run test:pg`). Everything here is about
 * SKIP LOCKED doing its job: no two workers on the same row, and nothing
 * dropped on the floor.
 */

function wrap(p: { query: Function }): Sql {
  return {
    query: (text, params) => p.query(text, params as any[]) as any,
    exec: async (text) => {
      await p.query(text);
    },
  };
}

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

async function seed(sql: Sql, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await sql.query(
      `INSERT INTO meetings (id, user_id, created_at) VALUES ($1, 'u1', now())`,
      [uuid(i)]
    );
    await enqueue(sql, uuid(i), 'transcribe');
  }
}

test('one job, many simultaneous workers: exactly one claim wins', skipUnlessPg, async () => {
  const s = await freshSchema();
  const admin = wrap(s.pool());
  await migrate(admin);
  await seed(admin, 1);

  const workers = Array.from({ length: 8 }, () => wrap(s.pool()));
  const results = await Promise.all(workers.map((w) => claim(w, ['transcribe'], 1)));

  const winners = results.flat();
  assert.equal(winners.length, 1, 'a job was handed to more than one worker');
  await s.drop();
});

test('many jobs, many workers: every job claimed exactly once', skipUnlessPg, async () => {
  const s = await freshSchema();
  const admin = wrap(s.pool());
  await migrate(admin);
  await seed(admin, 40);

  const workers = Array.from({ length: 6 }, () => wrap(s.pool()));
  const drain = async (w: Sql): Promise<Job[]> => {
    const mine: Job[] = [];
    for (;;) {
      const batch = await claim(w, ['transcribe'], 3);
      if (batch.length === 0) return mine;
      mine.push(...batch);
      for (const job of batch) await complete(w, job.id);
    }
  };

  const claimed = (await Promise.all(workers.map(drain))).flat();
  const ids = claimed.map((j) => j.id);

  assert.equal(ids.length, 40, 'jobs were lost or duplicated');
  assert.equal(new Set(ids).size, 40, 'the same job was claimed twice');

  const { rows } = await admin.query<{ n: string }>(
    `SELECT count(*) AS n FROM jobs WHERE status <> 'done'`
  );
  assert.equal(Number(rows[0].n), 0);
  await s.drop();
});

test('a slow worker does not block others from claiming', skipUnlessPg, async () => {
  const s = await freshSchema();
  const admin = wrap(s.pool());
  await migrate(admin);
  await seed(admin, 2);

  const slow = wrap(s.pool());
  const other = wrap(s.pool());

  const [a] = await claim(slow, ['transcribe'], 1);
  // The first job is still running; the second must remain available.
  const [b] = await claim(other, ['transcribe'], 1);

  assert.ok(a && b);
  assert.notEqual(a.id, b.id);
  await s.drop();
});

test('concurrent duplicate enqueues still produce one job', skipUnlessPg, async () => {
  const s = await freshSchema();
  const admin = wrap(s.pool());
  await migrate(admin);
  await admin.query(
    `INSERT INTO meetings (id, user_id, created_at) VALUES ($1, 'u1', now())`,
    [uuid(0)]
  );

  // Invariant #3 under a real race: the app retrying upload-complete while the
  // first call is still in flight.
  const callers = Array.from({ length: 10 }, () => wrap(s.pool()));
  await Promise.all(callers.map((c) => enqueue(c, uuid(0), 'transcribe')));

  const { rows } = await admin.query<{ n: string }>(`SELECT count(*) AS n FROM jobs`);
  assert.equal(Number(rows[0].n), 1);
  await s.drop();
});

test('a failed job is not re-claimed until its backoff elapses', skipUnlessPg, async () => {
  const s = await freshSchema();
  const admin = wrap(s.pool());
  await migrate(admin);
  await seed(admin, 1);

  const w1 = wrap(s.pool());
  const [job] = await claim(w1, ['transcribe'], 1);
  await fail(w1, job, 'sarvam 503');

  const w2 = wrap(s.pool());
  assert.deepEqual(await claim(w2, ['transcribe'], 1), []);
  await s.drop();
});
