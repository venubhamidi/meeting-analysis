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
npm run test:pg # the full suite: Postgres 16 + MinIO in containers
```

`npm run test:pg` is now the real suite — 25 of the 39 tests need either a
second connection (concurrency) or an S3 endpoint (upload, API), and skip
loudly without them. `npm test` still runs the queue and schema tests with no
daemon, but a green run there does not mean the upload path works.

`npm test` is the default loop. It cannot cover multi-worker contention —
PGlite is single-connection — so the `SKIP LOCKED` behaviour that stops two
workers claiming one job lives in `tests/concurrency.test.ts`, which skips
unless `TEST_PG_URL` is set. Removing `FOR UPDATE SKIP LOCKED` from the claim
query fails those two tests and no others; run them before trusting a change to
the queue.

`test:pg` also matches production's Postgres 16, which PGlite does not.

Start both containers first:

```
docker run -d --name mi-pg-test -e POSTGRES_PASSWORD=test \
  -e POSTGRES_DB=meetings_test -p 55432:5432 postgres:16

docker run -d --name mi-minio -p 59000:9000 \
  -e MINIO_ROOT_USER=minioadmin -e MINIO_ROOT_PASSWORD=minioadmin \
  minio/minio server /data
```

MinIO stands in for R2: same S3 API and the same presigned-URL mechanics, so
the upload path is exercised for real without credentials or network. The
production code path was also verified once against the live R2 bucket.

## Upload design

R2 requires every multipart part except the last to be at least 5 MiB and all
of equal size. The app's segments are ~480 KB, so SPEC.md §4.3's single
multipart upload per recording is not usable at this granularity. Instead each
segment is its own R2 object uploaded with a plain presigned PUT, and the
worker concatenates them before transcription — one file, one diarization pass,
so speaker labels stay consistent across the whole meeting.

A failed upload therefore retries one ~480 KB segment rather than a 5 MiB part,
which is stricter than invariant #2 requires.
