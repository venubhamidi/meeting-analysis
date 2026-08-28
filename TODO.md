# TODO

Status as of 2026-08-27. `SPEC.md` is the source of truth for design; this file
tracks what is actually built, what is verified, and what is left.

Scope has narrowed since SPEC.md was written. The product is now five
capabilities: **speech to text, source-language → English, summarization,
sentiment analysis, and search via chatbot.** Roll-ups (SPEC.md §11 phase 6) and
the Q&A tab as specified are out of scope; the chatbot replaces them.

---

## Ready

Built and verified end to end, four times, on four languages.

| Capability | Where | Verified by |
|---|---|---|
| Speech to text | `pipeline/sarvam.ts`, `pipeline/transcribe.ts` | 4 meetings, 214 segments |
| Language auto-detect | `DEFAULT_LANGUAGE = 'unknown'`, stored by `007_language.sql` | te/hi/ta all correct |
| Summarization | `pipeline/analyze.ts` | Source-language + English, each in its own language |
| Sentiment | `analyses.sentiment` | Per topic and per speaker |
| Verbatim quotes | `validateQuotes()` | 38 quotes, 0 dropped, 0 non-verbatim |
| Dashboard + filters | `api/dashboard.ts` | Language, sentiment, status, date, spoken words |
| HTML reports | `scripts/build-report.mts` | 4 published with audio + per-quote playback |

Supporting work: production schema `meeting_analysis` (7 migrations, owned by
`meetings_app`); `scripts/seed.mts` loads samples idempotently; 47 tests pass;
eleven languages wired for future use with the runbook in `worker/README.md`.

The mobile app (SPEC.md §11 phases 1–3) records offline, uploads segments and
displays transcripts and analysis. Built, but never run on hardware.

---

## Pending

### 1. Chatbot search — nothing behind it

`chunks` has a table and an hnsw index (`006_chunks.sql`) and zero rows. Missing:
the embed stage (chunk → bge-m3 → `chunks`), retrieval, a chat endpoint, and any
UI. This is the only one of the five capabilities with no implementation.

Blocker for local work: neither PGlite nor the `mi-pg-test` container ships
pgvector, so `chunks.embedding` exists only in production. Switch the container to
`pgvector/pgvector:pg16` before writing embedding code, or it has no test coverage.

### 2. Validation against real recordings

The SPEC.md §11.2 quality gate has not been passed for any language. Three of the
four samples are synthetic text-to-speech. Open questions that only the client's
own audio can settle:

- **Diarization under-counts speakers** — 3 of 4 on Telangana and Tamil, on clean
  audio with no overlap or background noise. Speaker attribution is what quotes
  and per-speaker sentiment rest on.
- **Low detection confidence on the one realistic recording** — Telugu came back
  `te-IN` at p=0.54, against 0.90–0.99 for the synthetic three.
- **Script inconsistency** — the same word appears in two scripts within one
  meeting (`సాబ్` and `Saab`, `మొహల్లా` and `mohalla`). FTS uses the `simple`
  tokenizer, so those are different tokens and a search for one misses the other.
- **Numerals are transcribed as digits** — `మూడు` → `3`, `ఏడు గంటలకు` → `7:00 AM`.
  Facts survive; the transcript no longer matches what was spoken.

### 3. Sentiment is unusable as a filter

The model invents a label per meeting: 13 distinct values across 4 meetings
(`negative`, `concerned`, `frustrated`, `worried but hopeful`, `concerned
(dignity issue)`, …). Constrain to a fixed enum in `pipeline/analysisSchema.ts`.
This is the filter that most visibly looks broken.

### 4. Mobile app on device

`app/DEVICE-TESTS.md` covers crash-mid-recording and crash-during-rotation — the
invariants only real hardware can prove. Blocked on EAS: Xcode 16.2 on this Mac
is too old for Expo SDK 57.

### 5. Undecided

- **Does "source language → English" mean the whole transcript?** Today only the
  summary and the quotes are translated. Full-transcript translation needs a
  `text_en` column on `transcript_segments` and a translation pass per meeting —
  real recurring cost. Both are defensible; they are different products.
- **Rename `text_te` → `text_src` and `telugu_summary` → `summary_src`.** The
  content is correct for Hindi and Tamil; only the names lie. Free now while the
  tables are empty; a data migration once real recordings land.

### 6. Operational

- Railway `DATABASE_URL` must connect as **`meetings_app`**, not `postgres` — the
  role's `search_path` is what resolves `meeting_analysis`. As `postgres` it would
  fall through to `public`, which holds an unrelated application's data.
- The HTML report is a hand-run script, not a pipeline stage or an endpoint. If
  "generates HTML for validation" is a deliverable, it needs one of those.
- Dashboard auth is a single shared `DASHBOARD_TOKEN`. Per-user roles are separate
  work (see SPEC.md §13).
- `meetings.location`, `meetings.tags`, `analyses.action_items` and
  `analyses.structured_facts` are unused by the five capabilities. `tags` and
  `location` are worth keeping as dashboard filters; the other two are dead weight
  unless something consumes them.

---

## Order that unblocks the most

1. Constrain the sentiment enum — small, and the dashboard depends on it.
2. Build the embed stage and chat endpoint — the last missing capability.
3. Get the client's real recordings and run the §11.2 gate. This decides whether
   diarization is good enough to keep Sarvam, and nothing else can answer it.
