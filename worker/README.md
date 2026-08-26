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

## Audio concatenation

The transcribe stage joins a meeting's segments into one m4a before sending it
to Sarvam. This is not tidiness: transcribing segments separately restarts
diarization every 60 seconds, so "Speaker 1" in minute 3 would be unrelated to
"Speaker 1" in minute 4, breaking the meeting-scoped speaker labels in §7.

Requires **ffmpeg and ffprobe on PATH** (`FFMPEG_PATH` / `FFPROBE_PATH` to
override). The Railway image needs them installed.

ffmpeg's concat demuxer is unusually quiet about failure, so the stage does not
trust its exit code:

1. Every segment is probed before joining. An unreadable segment is skipped by
   the demuxer, which still exits 0 and produces a short file.
2. The joined file's duration must match the sum of its inputs, within 250ms.
   Segments at a mismatched sample rate are dropped *silently* — exit 0, no
   error output whatsoever — and only this check catches it.

`-xerror` was tried and rejected: it also fails on the "Non-monotonic DTS"
warning that is normal at AAC segment boundaries.

## Transcription

Sarvam **batch** Speech-to-Text, not the synchronous endpoint. This is forced,
not preferred: `/speech-to-text` does no diarization at all and targets clips
under 30 seconds, while meetings run ~30 minutes and SPEC.md §7 depends on
speaker labels.

Flow (verified against the live API on 2026-08-26):

```
POST /speech-to-text/job/init      -> job_id + Azure blob SAS URLs
PUT  <input_storage_path>/audio.m4a  (x-ms-blob-type: BlockBlob)
POST /speech-to-text/job           -> job_parameters
GET  /speech-to-text/job/{id}/status  until Completed
GET  <output_storage_path>/<file_id>.json
```

Provider quirks the client handles, each found by testing rather than reading:

- The output file is named by **file_id** (`0.json`), not by the name the audio
  was uploaded under.
- Output JSON is served with a **UTF-8 BOM**, which `JSON.parse` rejects.
- `speaker_id` is neither zero-based nor contiguous — a two-person conversation
  came back as ids 1 and 2 — so speakers are renumbered by first appearance.
  Using the ids directly labels a two-speaker meeting "Speaker 2"/"Speaker 3".
- `saaras:v4` exists on the sync endpoint but **not** on batch, which accepts
  only `saarika:v2.5` and `saaras:v3`.

### Model and mode

`saaras:v3` with `mode=codemix`. Compared on identical two-speaker code-mixed
Telugu audio:

| mode | output |
|---|---|
| `codemix` | `మా village-లో water problem చాలా serious-గా ఉంది` |
| `transcribe` | `మా విలేజ్లో వాటర్ ప్రాబ్లం చాలా సీరియస్గా ఉంది` |
| `translit` | `maa village lo water problem chala serious ga undi` |

`codemix` keeps English in Latin script as spoken, which is what §5's "Telugu
(or code-mixed) verbatim" describes, reads far better, and gives the analysis
stage a cleaner input. Diarization was equally accurate across all modes.

### Timestamps are chunk-level, not word-level

`timestamps.words` is misleadingly named: it returns sentence- or phrase-level
spans. A 5-second utterance came back as **one** element. SPEC.md §1, §4.4,
§5 and §6.1 assume word-level timestamps; the provider does not offer them on
any model or mode. Quote playback therefore resolves to the sentence containing
the quote — usually within a second — and invariant #6 should be reworded to
match. The `words` column stores the chunks overlapping each segment.

```
npm run worker    # poll the queue and transcribe
npm run test:live # end-to-end against the real Sarvam API (costs money)
```

## Quality gate harness

`scripts/e2e.mts` runs one recording through the entire pipeline — upload API,
storage, concat, Sarvam, Postgres — against throwaway containers, and dumps the
transcript as JSON. This is the tool for the SPEC.md §11.2 gate: point it at a
folder of the client's real 60-second segments and read the output before
building anything downstream.

### Validation run, 2026-08-26

A 19.4-minute synthetic Telugu meeting (165 turns, 4 speakers, Telugu-English
code-mixing, seeded with checkable numbers) split into twenty 60-second
segments and pushed through the whole pipeline.

| | result |
|---|---|
| Pipeline | 20 segments uploaded, concatenated, transcribed in **32s**, no retries |
| Transcript length | 98% of spoken characters |
| Per-turn accuracy | median **90%**, p25 75%, 28/165 turns below 70% |
| Numbers and amounts | **25/25** preserved (often normalised: "నలభై వేల" → "40,000") |
| Diarization | **4 speakers found for 4 actual**; main speaker 81 turns detected vs 81 spoken |
| Code-mixing | 24 of the 25 most common English words stayed in Latin script |
| Timeline coverage | 99.9% |

Where it struggles — all of it worth re-checking on real speech:

- **Acronyms and scheme names are unreliable.** MGNREGA → "ఎవరైనా", MeeSeva →
  "దిగే బలు", ICDS → "యహోయ్", Aadhaar → "Wadahar", RTC dropped. For a
  constituency use case these are exactly the terms that matter.
- **Whole clauses can vanish.** "Applications ఎక్కడ పెట్టారు? MeeSeva లోనా లేక
  Panchayat office లోనా?" came back as "Applications ఎప్పుడు పెట్టారు?" — the
  second question simply gone, with nothing marking the loss.
- **Telugu proper nouns may be romanised.** లక్ష్మమ్మ → "Lakshmamma", which
  matters for name search and the §7 participant autocomplete.

**This run does not establish real-world accuracy.** The audio is Sarvam's own
text-to-speech: clean, no background noise, no overlapping speech, one accent,
and — most importantly — a Telugu voice pronouncing English acronyms, which is
probably why they transcribed so badly. Real recordings may do better on
acronyms and worse on everything else. The gate still needs the client's audio.
