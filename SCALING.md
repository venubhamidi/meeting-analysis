# Scaling plan

Written 2026-08-26, after phases 1–3. The build so far targets SPEC.md's stated
case: one user, ~10 meetings a day. This records what happens at hundreds of
field surveyors, what already holds, and what must change.

## The economics move first

| | 1 surveyor | 100 surveyors |
|---|---|---|
| Audio per month | 110 hrs | 11,000 hrs |
| Sarvam transcription @ ₹45/hr | ₹4,950 | **₹4,95,000** |
| Claude analysis @ ₹5.86/meeting | ₹1,288 | ₹1,28,920 |
| R2 + Postgres | ~₹100 | ~₹4,000 |
| **Total** | **~₹6,300** | **~₹6.3 lakh** |

Linear, with no volume break. Two things to settle with Sarvam **before**
committing to that volume, because neither is an engineering problem:

1. Volume pricing. SPEC.md §12 already says to ask; at 11,000 hrs/month there
   is real leverage.
2. Rate limits on the batch API. Their docs do not state them, and transient
   504s appeared during test-audio generation at trivial volume. Unknown
   capacity at 1,000 meetings/day is a live risk.

## What already holds

These were deliberate and do not need revisiting:

- **Jobs queue.** `FOR UPDATE SKIP LOCKED` plus a lease means worker instances
  coordinate by themselves. Tested with six concurrent workers draining forty
  jobs with no loss or duplication.
- **Client-generated UUIDs, idempotent everywhere.** No server-side id
  allocation and no distributed locking, so many phones uploading at once do
  not contend.
- **Per-segment uploads.** No multipart session state held open server-side.
- **Offline-first recording.** Field surveyors without signal is the normal
  case, not the failure case.

## What breaks, and when

| # | Breaks | At | Fix |
|---|---|---|---|
| 1 | Shared device token | 2 users | Firebase phone OTP (§13) + users table with roles |
| 2 | Worker claims 1 job/tick, sleeps 5s idle | ~50 meetings/day | Configurable batch and concurrency; multiple instances |
| 3 | `/admin/failed-jobs` returns everything unpaginated | ~100 failures | Pagination and filters |
| 4 | Sequential segment upload | poor rural networks | Upload 3–4 segments in parallel |
| 5 | HNSW index over tens of millions of vectors | ~10 surveyors × 1 yr | Partition by date; dedicated Postgres |
| 6 | Single worker service (API + pipeline in one process) | ~20 surveyors | Split into separate Railway services |

## Decisions taken

**Embeddings are self-hosted, not an API.** `Xenova/bge-m3` runs in the worker
through transformers.js. Measured on linux/x64 (the Railway platform):

- 1024 dimensions — matches SPEC.md §5's `vector(1024)` with no schema change
- Telugu ↔ its English translation: cosine **0.777**; unrelated pairs ~0.51.
  Cross-lingual retrieval works, which is what §2 requires of the model.
- 569 MB quantized model; ~120 ms for three texts once loaded

Chosen over Voyage/Cohere for two reasons: no fourth processor sees transcripts
carrying incidental third-party names (§7), and no API key or per-token cost at
any volume. Behind an `Embedder` interface, so a hosted model stays a config
change.

**Worker RAM: 2 GB.** Measured floor is between 768 MB and 1 GB — 768 MB is
OOM-killed during model load, 1 GB works. 2 GB leaves room for ffmpeg and
concurrent jobs.

*Local development note:* `onnxruntime-node` ships no `darwin/x64` binding, so
embeddings cannot run natively on an Intel Mac. `linux/x64` and `darwin/arm64`
are shipped, so production and Apple Silicon are unaffected; test embeddings in
Docker on Intel machines.

## Order of work

Fold into phase 4 as it is built, because they are cheap now and expensive later:

- Configurable worker claim batch and concurrency
- Pagination on admin and list endpoints
- User scoping kept in one place, ready for `requireRole()`

Defer until volume is real: multiple worker instances, Postgres partitioning,
parallel segment upload, splitting API from pipeline.
