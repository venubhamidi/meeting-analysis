# Project: Meeting Intelligence App

Read `SPEC.md` in full before writing any code. It is the source of truth for architecture, schemas, and requirements.

## Build discipline

- Follow the build order in SPEC.md §11 strictly. **Build phases 1–2 only, then stop** for validation of Sarvam Telugu transcription quality on real recordings before any downstream work (analysis, search, roll-ups, Q&A).
- Do not build ahead of the current phase. Do not add features not in the spec.
- The invariants in SPEC.md §15 are acceptance criteria. Write tests for them where testable (sync state machine, idempotency, retry logic, quote-verbatim validation).

## Key decisions already made — do not revisit

- React Native (Expo), not Flutter, not PWA
- Cloudflare R2 with presigned multipart uploads (resumable, ~5 MB parts)
- Postgres on Railway (existing instance) + pgvector + FTS; worker service also on Railway
- Jobs table as queue (no Redis/BullMQ)
- **No persons table.** Speaker identity is meeting-scoped free-text labels only (SPEC.md §7)
- v1 auth: manually issued device token; Firebase phone OTP (+91) added later per SPEC.md §13
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

## When uncertain

- If the spec is ambiguous or a third-party API differs from what the spec assumes, ask or check official docs — do not guess or invent endpoints, parameters, or pricing.
