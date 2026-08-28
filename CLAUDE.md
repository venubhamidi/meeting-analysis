# Project: Meeting Intelligence App

Read `SPEC.md` in full before writing any code. It is the source of truth for architecture, schemas, and requirements.

## Build discipline

- Scope is five capabilities: speech to text, source-language → English, summarization, sentiment analysis, and search via chatbot. Roll-ups and the Q&A tab as SPEC.md §11 describes them are **out of scope** — see `TODO.md`, which is the current status of record.
- SPEC.md §11 phases 1–3 and a web dashboard are built. The remaining capability is the chatbot: `chunks` exists, the embed stage and retrieval do not.
- **The §11.2 quality gate has not been passed.** No language has been validated against the client's real recordings; three of the four samples are synthetic text-to-speech. Treat transcription quality as unproven, and do not read a synthetic run as evidence.
- The invariants in SPEC.md §15 are acceptance criteria. Write tests for them where testable (sync state machine, idempotency, retry logic, quote-verbatim validation).

## Key decisions already made — do not revisit

- React Native (Expo), not Flutter, not PWA
- Cloudflare R2 with presigned multipart uploads (resumable, ~5 MB parts)
- Postgres on Railway (existing instance) + pgvector + FTS; worker service also on Railway
- Jobs table as queue (no Redis/BullMQ)
- **No persons table.** Speaker identity is meeting-scoped free-text labels only (SPEC.md §7)
- **Language is detected, never configured.** Sarvam runs with `language_code: 'unknown'`; the analysis prompt names the language it finds from the transcript's script. One worker serves every language.
- **Embeddings are self-hosted** (`Xenova/bge-m3`, 1024 dims), not Voyage or Cohere as SPEC.md §2 originally said. See SCALING.md.
- v1 auth: manually issued device token; Firebase phone OTP (+91) added later per SPEC.md §13. The dashboard has its own single `DASHBOARD_TOKEN` (browsers cannot set the device header); per-user roles are separate work
- API keys server-side only; the app never calls Sarvam/Claude/R2/embeddings directly

## Non-negotiables

- Offline-first: recording and browsing work with zero connectivity
- Segment-safe recording: a crash mid-recording preserves audio up to that point
- No silent data loss: explicit state machine, retries with backoff, stuck items surfaced in UI
- Quotes must be verbatim substrings of the transcript — worker validates and rejects otherwise
- Q&A answers only from retrieved excerpts with citations, or "no recorded conversations mention this"

## Environment

- Secrets via Railway env vars (SPEC.md §10). Never commit keys. Use `.env.example` with placeholder names.
- Target devices: real iPhone (primary) and Android. iOS build via EAS → TestFlight internal. `NSMicrophoneUsageDescription` required in app config.
- Verify current Sarvam API request/response format against docs.sarvam.ai before implementing the transcription client — do not code it from memory.
- Production Postgres uses the **`meeting_analysis`** schema, owned by `meetings_app`. `DATABASE_URL` must connect as `meetings_app`, whose `search_path` resolves it — as `postgres` it falls through to `public`, which holds an unrelated application's data.
- PGlite and the local `mi-pg-test` container ship no pgvector, so `chunks.embedding` exists only in production. Embedding work needs `pgvector/pgvector:pg16` locally or it has no test coverage.

## When uncertain

- If the spec is ambiguous or a third-party API differs from what the spec assumes, ask or check official docs — do not guess or invent endpoints, parameters, or pricing.
