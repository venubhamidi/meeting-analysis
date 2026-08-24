# worker

Server-side pipeline and API for the Meeting Intelligence app (SPEC.md §6, §9).

## Database

Runs against the `meetings` schema of the Railway Postgres instance. Connect as
the `meetings_app` role — its `search_path` is set at the role level to
`meetings, extensions`, so nothing needs schema qualifiers and nothing can
silently land in `public`. pgvector 0.8.6 lives in the `extensions` schema.

```
DATABASE_URL=postgresql://meetings_app:<password>@<host>:<port>/railway npm run migrate
```

## Tests

```
npm test        # PGlite in-process: hermetic, no daemon, PG 18
npm run test:pg # the same suite plus concurrency tests, against Postgres 16
```

`npm test` is the default loop. It cannot cover multi-worker contention —
PGlite is single-connection — so the `SKIP LOCKED` behaviour that stops two
workers claiming one job lives in `tests/concurrency.test.ts`, which skips
unless `TEST_PG_URL` is set. Removing `FOR UPDATE SKIP LOCKED` from the claim
query fails those two tests and no others; run them before trusting a change to
the queue.

`test:pg` also matches production's Postgres 16, which PGlite does not.

Start the container first:

```
docker run -d --name mi-pg-test -e POSTGRES_PASSWORD=test \
  -e POSTGRES_DB=meetings_test -p 55432:5432 postgres:16
```
