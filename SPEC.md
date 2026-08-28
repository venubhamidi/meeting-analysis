# Meeting Intelligence App — Implementation Specification

> **Status (2026-08-27).** Scope has narrowed since this was written: the product
> is now five capabilities — speech to text, source-language → English,
> summarization, sentiment analysis, and search via chatbot. Roll-ups (§11 phase
> 6) and the Q&A tab as specified (§11 phase 7) are **superseded** by the
> chatbot; the `summaries` table in §5 is not built. A web dashboard, absent
> below, is built and replaces the roll-up UI for review. `TODO.md` tracks what
> is built versus verified. Sections corrected against the live APIs are marked
> inline.

## 1. Overview

A cross-platform mobile app (iPhone + Android) for a client who meets ~10 people per day and records ~30-minute conversations in Indic languages with English code-mixing — Telugu (including the Telangana dialect), Hindi and Tamil so far. The language is detected per recording rather than configured. The system transcribes, analyzes sentiment, and produces bilingual (source language + English) summaries with verbatim quotes. All content is stored, searchable, and queryable via a grounded chatbot.

**Non-negotiable principles:**

1. **Offline-first.** Recording and browsing must work with zero connectivity. Rural/mobile networks are assumed flaky.
2. **Nothing is ever silently lost.** Every recording is durably stored somewhere (phone or cloud) at every moment, with explicit state tracking and retries.
3. **Validation chain.** Every claim, quote, and summary statement must be traceable back to the audio moment it came from. (Sarvam's `timestamps.words` is chunk-level — a phrase or sentence, not a word — verified against the live API, so playback resolves to the sentence containing the quote.) Quotes must be verbatim from transcripts — never paraphrased-as-quote. Q&A answers must cite sources or say "no recorded conversations mention this."
4. **No people database.** Speaker identity is meeting-scoped free-text annotation only. No canonical person registry, no profiles. (See §7.)
5. **API keys never on the device.** All third-party calls (Sarvam, Claude, embeddings) happen server-side.

---

## 2. Stack

| Layer | Choice | Notes |
|---|---|---|
| Mobile app | React Native (Expo) | One codebase, iOS + Android. Native app required — PWA audio recording is unreliable on iOS Safari. |
| Local storage | SQLite (expo-sqlite) + FTS | Offline metadata, sync state machine, local full-text search. |
| Audio storage | Cloudflare R2 | S3-compatible. Presigned multipart uploads. Zero egress fees. Originals kept forever (ground truth). |
| Database | Postgres on Railway | Already provisioned. Enable `pgvector` extension (`CREATE EXTENSION vector;`). Use built-in FTS (`tsvector`). Verify the Railway Postgres image supports pgvector; if not, use the `pgvector/pgvector` image. |
| Worker/API | Node or Python service on Railway | Same Railway project as Postgres. Runs the pipeline, generates presigned URLs, serves the app API. |
| Transcription | Sarvam AI Speech-to-Text (Saaras) | 22 Indic languages plus Indian English; language auto-detected (`language_code: 'unknown'`). Speaker diarization, chunk-level timestamps (not word-level), code-mixing support. ~₹1.5/min (verify current pricing at dashboard.sarvam.ai). **No European languages** — French and similar need a second provider. |
| Analysis | Claude API (claude-sonnet-4-6) | Per-meeting analysis, roll-ups, Q&A answering. |
| Embeddings | Self-hosted `Xenova/bge-m3` via transformers.js | Superseded Voyage/Cohere — see SCALING.md. 1024 dimensions, matching §5's `vector(1024)`. Multilingual, so English queries match Indic content. Runs in the worker; no fourth processor sees transcripts. |
| Auth | Firebase Auth (phone OTP, +91 users) | Single primary user initially. See §13 for India-specific details and the v1 device-token shortcut. |
| Push | Firebase Cloud Messaging | Phase 2. "Your meetings are analyzed" notification. |
| Monitoring | Sentry (app + worker) + Railway logs | Silent transcription failure is the top risk; alert on it. |
| Backups | Railway Postgres backups ON; R2 versioning optional | Recordings are irreplaceable. |

---

## 3. High-Level Flow

```
[Phone: record m4a, segmented] 
  → local SQLite (state: recorded)
  → sync engine: multipart upload to R2 via presigned URLs (resumable)
  → server: job created (transcribe)
  → worker: Sarvam STT → transcript w/ diarization + word timestamps
  → worker: Claude analysis → Telugu summary, English summary, quotes, sentiment, action items, structured facts
  → worker: chunk + embed transcript → pgvector
  → app syncs results down → local SQLite (state: synced)
  → nightly job: daily roll-up → weekly (Sun) → monthly (1st)
  → Q&A tab: RAG over chunks + summaries + facts
```

---

## 4. Client App (React Native / Expo)

### 4.1 Recording

- Record m4a/AAC. 30 min ≈ 15–30 MB.
- **Write to disk in segments while recording** (rotate file every ~60s or use append mode). A crash at minute 25 must preserve 25 minutes.
- Assign a client-generated UUID to every recording **at record time** (idempotency key for all server interactions).
- Never delete local audio until server confirms **transcription** succeeded (not merely upload).

### 4.2 Local SQLite Schema

```sql
CREATE TABLE recordings (
  id TEXT PRIMARY KEY,              -- client-generated UUID
  created_at TEXT NOT NULL,         -- ISO8601
  duration_seconds INTEGER,
  file_path TEXT NOT NULL,          -- local path
  file_size_bytes INTEGER,
  state TEXT NOT NULL DEFAULT 'recorded',
    -- recorded | queued | uploading | uploaded | transcribing | analyzed | synced | stuck
  upload_id TEXT,                   -- R2 multipart uploadId
  parts_total INTEGER,
  parts_completed TEXT,             -- JSON array of completed part numbers
  attempts INTEGER DEFAULT 0,
  next_retry_at TEXT,
  last_error TEXT,
  wifi_only INTEGER DEFAULT 1,      -- per-recording cellular override
  notes_text TEXT,
  location TEXT,
  tags TEXT                          -- JSON array
);

CREATE TABLE participants_local (
  recording_id TEXT NOT NULL,
  diarization_label TEXT NOT NULL,  -- "Speaker 1"
  display_name TEXT,
  display_title TEXT,
  PRIMARY KEY (recording_id, diarization_label)
);

-- Synced-down content for offline browsing/search
CREATE TABLE transcripts_local (
  recording_id TEXT PRIMARY KEY,
  telugu_summary TEXT,
  english_summary TEXT,
  sentiment_json TEXT,
  quotes_json TEXT,
  transcript_json TEXT              -- segments w/ speaker, timestamps
);

CREATE VIRTUAL TABLE search_fts USING fts5(
  recording_id, content, summary_te, summary_en, names
);
```

### 4.3 Sync Engine (critical component)

State machine per recording:

```
recorded → queued → uploading (part n/m) → uploaded → transcribing → analyzed → synced
```

- Runs: on app foreground, on connectivity-regained (NetInfo listener), and in iOS/Android background fetch windows. Design assumes most uploads happen while app is open or end-of-day — iOS background execution is limited; do not depend on it.
- **Resumable uploads:** S3 multipart to R2, ~5 MB parts, via presigned part URLs from the server. Persist `upload_id` + completed part numbers in SQLite so resume survives app restart. On drop, resume from next incomplete part.
- **Retries:** exponential backoff with jitter — 30s, 2m, 10m, 30m, capped at 1h. Never give up permanently; after 24h stuck, set state `stuck` and surface prominently in UI.
- **Idempotency:** every server call carries the recording UUID; server upserts. Duplicate "create job" or re-completed multipart must be harmless.
- WiFi-only default with per-recording "upload now on cellular" override.

### 4.4 UI Screens

1. **Record** — big record button, live duration, segment-safe indicator.
2. **Meetings list** — per-recording status chip (e.g., "uploading 4/6", "analyzed"), global banner "3 recordings pending upload". The user must always know what is safe vs. still on the phone.
3. **Meeting detail** — bilingual summary, sentiment, quotes (each quote tappable → plays the sentence containing it; see principle 3), full transcript with speaker labels, notes/metadata editor, speaker labeling (see §7).
4. **Search** — local FTS offline; server semantic search when online.
5. **Summaries** — daily/weekly/monthly, each claim drills down: month → week → day → meeting → quote → audio.
6. **Ask (Q&A chat)** — question box, streamed answer, citation chips that jump to transcript segment.

---

## 5. Server: Postgres Schema (Railway)

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE meetings (
  id UUID PRIMARY KEY,                    -- same UUID as client
  user_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  duration_seconds INT,
  audio_key TEXT,                         -- R2 object key
  audio_size_bytes BIGINT,
  status TEXT NOT NULL DEFAULT 'uploaded',
    -- uploaded | transcribing | transcribed | analyzing | analyzed | failed
  notes_text TEXT,
  location TEXT,
  tags TEXT[],
  created_row_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE transcript_segments (
  id BIGSERIAL PRIMARY KEY,
  meeting_id UUID REFERENCES meetings(id),
  seq INT NOT NULL,
  diarization_label TEXT,                 -- "Speaker 1"
  start_ms INT NOT NULL,
  end_ms INT NOT NULL,
  text_te TEXT NOT NULL,                  -- Telugu (or code-mixed) verbatim
  words JSONB,                            -- word-level timestamps from Sarvam
  low_confidence BOOLEAN DEFAULT false,   -- flag for review
  tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', text_te)) STORED
);
CREATE INDEX ON transcript_segments USING gin(tsv);
CREATE INDEX ON transcript_segments (meeting_id, seq);

-- Speaker identity: meeting-scoped labels ONLY. No persons table. See §7.
CREATE TABLE meeting_participants (
  meeting_id UUID REFERENCES meetings(id),
  diarization_label TEXT NOT NULL,
  display_name TEXT,
  display_title TEXT,
  PRIMARY KEY (meeting_id, diarization_label)
);
CREATE INDEX ON meeting_participants (display_name);

CREATE TABLE analyses (
  meeting_id UUID PRIMARY KEY REFERENCES meetings(id),
  telugu_summary TEXT,
  english_summary TEXT,
  quotes JSONB,        -- [{speaker_label, text_te (verbatim), text_en, start_ms, end_ms, segment_id}]
  sentiment JSONB,     -- per speaker and per topic
  action_items JSONB,  -- [{description, speaker_label, due_hint}]
  structured_facts JSONB, -- {people:[], commitments:[], amounts:[], dates:[], topics:[]}
  model TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE summaries (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,                     -- daily | weekly | monthly
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  telugu_text TEXT,
  english_text TEXT,
  structured_facts JSONB,                 -- passed upward UNCHANGED from children
  source_ids JSONB,                       -- meeting ids (daily) or summary ids (weekly/monthly)
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (user_id, type, period_start)
);

CREATE TABLE chunks (
  id BIGSERIAL PRIMARY KEY,
  meeting_id UUID REFERENCES meetings(id),
  -- summary_id BIGINT REFERENCES summaries(id),  -- NOT BUILT: roll-ups are out of scope (006_chunks.sql)
  chunk_type TEXT NOT NULL,               -- transcript | summary
  text TEXT NOT NULL,                     -- includes speaker names when labeled
  meta JSONB,                             -- {date, speaker_label, display_name, start_ms, end_ms}
  embedding vector(1024)                  -- match embedding model dimension
);
CREATE INDEX ON chunks USING hnsw (embedding vector_cosine_ops);

CREATE TABLE jobs (
  id BIGSERIAL PRIMARY KEY,
  meeting_id UUID,
  type TEXT NOT NULL,      -- transcribe | analyze | embed | rollup_daily | rollup_weekly | rollup_monthly
  payload JSONB,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | running | done | failed
  attempts INT DEFAULT 0,
  max_attempts INT DEFAULT 8,
  next_retry_at TIMESTAMPTZ DEFAULT now(),
  last_error TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (meeting_id, type)               -- idempotency: one job per meeting per stage
);
CREATE INDEX ON jobs (status, next_retry_at);
```

---

## 6. Worker Pipeline

Single Railway service. Poll loop: `SELECT ... FROM jobs WHERE status='pending' AND next_retry_at < now() ORDER BY created_at LIMIT n FOR UPDATE SKIP LOCKED`.

### 6.1 Stages (each independently retryable)

1. **transcribe** — download audio from R2 → junk gate → Sarvam STT (language auto-detected, diarization ON, timestamps ON; detected code and probability stored on `meetings`) → write `transcript_segments`, flag low-confidence segments → meeting status `transcribed` → enqueue `analyze`. Never re-run if segments already exist (idempotent check).
2. **analyze** — build prompt with full transcript + any speaker labels + meeting notes → Claude → write `analyses` → enqueue `embed`. If transcription succeeded but analysis fails, retry ONLY analysis (never re-pay for transcription).
3. **embed** — chunk transcript per speaker turn or ~500 tokens; include speaker display names in chunk text when available → embeddings API → write `chunks`.
4. **rollup_daily** — nightly (and on-demand): feed the day's per-meeting summaries + structured_facts (NOT raw transcripts) to Claude → daily summary. Facts arrays are merged/passed upward unchanged — prose can compress, numbers and commitments must not.
5. **rollup_weekly / rollup_monthly** — aggregate child summaries + facts the same way. Sunday night / 1st of month.

### 6.2 Failure handling

- On failure: `attempts++`, exponential backoff into `next_retry_at`, store `last_error`.
- After `max_attempts`: status `failed`, Sentry alert, visible in a minimal admin view. A human decides; no silent loss.

### 6.3 Claude analysis prompt requirements

The per-meeting analysis prompt MUST instruct:

- Output strict JSON: `{telugu_summary, english_summary, quotes[], sentiment{}, action_items[], structured_facts{}}`.
- **Quotes must be verbatim substrings of the provided transcript text** — never paraphrase, never translate-and-call-it-a-quote. Each quote must include the segment reference and start/end ms (worker validates: reject any quote whose text is not found in the transcript, and retry with a correction message).
- English translations of quotes are provided separately alongside the verbatim Telugu.
- Sentiment per speaker and per topic, with brief evidence.
- structured_facts: people mentioned, commitments/promises (who, what, when), amounts, dates, topics.
- Use speaker display names where provided; otherwise keep diarization labels.
- Do not invent information not present in the transcript.

### 6.4 Roll-up prompt requirements

- Input: child summaries + merged structured_facts only.
- Output both languages, notable quotes carried up by reference (segment ids), recurring themes, sentiment trend, open action items.
- Facts JSON is merged programmatically by the worker, not rewritten by the model.

---

## 7. Speaker Identity — Labels, NOT a People Database

**Explicit product decision: no persons table, no contact profiles, no person screens.** Identity exists only as free-text annotation on each meeting.

- User taps a speaker in the transcript, hears a snippet, types name/title: stored in `meeting_participants` for that meeting only.
- **Autocomplete** when typing a name = `SELECT DISTINCT display_name, display_title, MAX(created_at) ...` across past meetings — a string lookup with context shown ("Ramesh — Sarpanch, Kondapur, last met Jul 12"), not a profile.
- "Previous conversations with Ramesh" = query over labels, computed on demand.
- If labeling happens after analysis ran: substitute names at display time from the mapping; offer an explicit "Regenerate summary with names" button (it costs a Claude call). Do NOT auto-re-run.
- Accepted trade-off: two different "Ramesh" labels may conflate; mitigated by contextual autocomplete. A persons table can be derived from labels later in one migration if ever wanted.
- Privacy: recordings carry incidental names of third parties. Encrypt at rest (R2 + Railway support it), tight auth, no public exposure. Retention decision belongs to the client.

---

## 8. Search & Q&A (RAG)

### 8.1 Search

- **Offline:** local SQLite FTS over synced summaries/transcripts/names.
- **Online keyword:** Postgres FTS over `transcript_segments.tsv` + summaries.
- **Semantic:** embed query (same multilingual model) → cosine top-k over `chunks` → results grouped by meeting.

### 8.2 Q&A ("Ask" tab)

Flow for a question like "Is the current senator doing his job?":

1. Embed question (English or Telugu — multilingual embeddings bridge them).
2. Optional metadata pre-filter (date range, name) parsed from the question.
3. Retrieve top-k across transcript chunks, daily/weekly summaries, structured facts.
4. Claude answer with strict grounding rules:
   - Answer ONLY from provided excerpts. Never from general knowledge. Never editorialize about people/politicians.
   - Every claim carries a citation: meeting id + date + segment reference. Uncited claims are rejected.
   - If nothing relevant: say "no recorded conversations mention this."
   - Counting questions ("how many complained about water?") are answered from structured_facts queries computed by the server, with the model narrating the computed result — the model does not count.
   - Inject current date + meeting dates so "current"/"recently" resolve correctly.
5. App renders answer with tappable citation chips → transcript segment → audio playback.

---

## 9. API Surface (worker service)

```
POST /recordings/:id/upload-init      → { uploadId, presigned part URLs }
POST /recordings/:id/upload-part-url  → presigned URL for part n (re-request on resume)
POST /recordings/:id/upload-complete  → completes multipart, upserts meeting, enqueues transcribe job
GET  /recordings/:id                  → status + results (transcript, analysis) for sync-down
GET  /recordings?since=…              → delta sync
PUT  /recordings/:id/metadata         → notes, tags, location (last-write-wins)
PUT  /recordings/:id/participants     → speaker labels (last-write-wins)
POST /recordings/:id/regenerate       → re-run analysis with names (explicit, user-triggered)
GET  /participants/suggest?q=…        → distinct-label autocomplete with context
GET  /search?q=…&mode=keyword|semantic
POST /ask                             → { question } → streamed grounded answer + citations
GET  /summaries?type=…&period=…
GET  /audio/:id/playback-url          → short-lived presigned R2 URL (supports range for seek-to-quote)
GET  /admin/failed-jobs               → minimal admin visibility
```

All endpoints idempotent on client UUID. Auth: Firebase ID token verified server-side.

---

## 10. Configuration & Secrets

Railway environment variables (never in the app):

```
DATABASE_URL, R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET,
SARVAM_API_KEY, ANTHROPIC_API_KEY, EMBEDDINGS_API_KEY,
FIREBASE_PROJECT_ID (+ service account), SENTRY_DSN
```

---

## 11. Build Order (each phase ships something usable)

1. **Record + local storage + list view** — fully offline, segment-safe recording, state machine skeleton.
2. **Upload + transcription** — presigned multipart to R2, jobs table, Sarvam integration, transcript view. *Validate ASR quality with the client's real recordings here, before building downstream.* **This gate has not been passed** — see TODO.md.* (Compare Sarvam vs Google Chirp on the same files if quality disappoints.)
3. **Claude per-meeting analysis** — bilingual summaries, verbatim-quote validation, quote→audio playback.
4. **Search** — local FTS, then Postgres FTS, then embeddings + semantic.
5. **Speaker labeling + metadata** — labels, autocomplete, display-time substitution, regenerate button.
6. ~~**Roll-ups** — daily/weekly/monthly with facts pass-through and drill-down UI.~~ **Out of scope.** The web dashboard covers review; nothing builds the `summaries` table.
7. **Chatbot** (was: Q&A tab) — RAG over transcript chunks with grounding + citations. Table exists (`006_chunks.sql`); the embed stage, retrieval and UI are not built.
8. **Polish** — FCM notifications, Sentry, admin failed-jobs view, backups verified.

---

## 12. Cost Envelope (verify current pricing before quoting the client)

- Sarvam STT: ~₹1.5/min → ~₹450/day at 10×30min → ~₹13.5K/month (dominant cost; ask about volume discounts)
- Claude analysis + roll-ups + Q&A: a few hundred ₹/month
- Embeddings: pennies at this volume
- R2: ~9 GB/month growth → ~$2/month by end of year 1
- Railway: existing plan; small worker + Postgres
- Apple Developer $99/yr (account already active) + Google Play $25 one-time, optional (TestFlight internal / sideloaded APK sufficient for a single client — see §14)
- Firebase Blaze plan: SMS OTP a few cents per verification; negligible at login-once-per-device frequency

---

## 13. Authentication & Authorization

### 13.1 Authentication — Firebase Phone OTP (users are in India, +91)

- Flow: app sends phone number → Firebase sends SMS OTP → user enters code → Firebase issues ID token → app attaches token to every API call → Railway worker verifies with Firebase Admin SDK. Tokens refresh silently; login is effectively once per device.
- **India-specific requirements:**
  - SMS OTP delivery in India can be slow (30–60s+) due to DLT telecom regulations. Firebase handles DLT registration, but the UI MUST include a "Resend code" button enabled after ~30 seconds.
  - On Android, use the SMS Retriever API (supported by Firebase) for auto-read of the OTP — no SMS permission prompt required.
  - Firebase phone auth requires the **Blaze (pay-as-you-go) plan**; India SMS costs a few cents per verification (negligible at this scale, but a billing account must be attached). Verify current rates in the Firebase console.
  - Test the full OTP flow on a **real +91 SIM** before client handoff.
- **iOS quirk:** phone auth on iOS requires silent APNs notifications or reCAPTCHA fallback. Works with Expo **dev builds** (not Expo Go); requires correct APNs configuration. Budget setup time for this.
- **v1 shortcut (acceptable):** since there is initially one known user, phases 1–2 may ship with a manually issued long-lived device token instead of Firebase, verified by the worker. Add Firebase phone auth before any second user or external tester. Do not let auth polish block the pipeline build.
- Fallback options if SMS proves unreliable in the field (do not build unless needed): WhatsApp OTP via MSG91/Gupshup, or Truecaller SDK one-tap.

### 13.2 Authorization

- Simple ownership model: every table carries `user_id`; every query filters by the verified token's user id. No roles in v1.
- Structure API middleware as `requireUser()` with a `requireRole()` extension point, so adding owner/viewer roles later (e.g., staff who can read/search but not delete or regenerate) is a small change, not a rewrite.
- **Presigned URLs are the real authorization surface for audio:** short-lived (minutes), scoped to a single object, issued only to authenticated requests. Playback URLs support HTTP range requests (seek-to-quote).
- All third-party API keys remain server-side only (§10). The app never calls Sarvam/Claude/R2/embeddings directly.

---

## 14. Distribution & Publishing

**Strategy: stay off the public app stores.** Single-client distribution avoids public App Review entirely.

### 14.1 iOS

- **Apple Developer account: already available** — no enrollment wait.
- Build with EAS: `eas build --platform ios`. EAS logs into the Apple account once and auto-manages app identifier, certificates, and provisioning profiles (no manual Xcode certificate work).
- `eas submit` → App Store Connect → build appears in **TestFlight** ~15–30 min after processing.
- Distribute via **TestFlight internal testers** (up to 100): add the client's Apple ID; **no App Review required**. External testers would trigger a lightweight beta review (~1 day) and require a privacy policy — avoid unless needed.
- TestFlight builds expire after 90 days → push a fresh build periodically (natural, since the app will be iterating).
- `app.json` MUST include `NSMicrophoneUsageDescription` with an honest string (e.g., "Records your meetings for transcription and summaries"). Missing string = crash on first record.

### 14.2 Android

- **Internal testing track** on Google Play ($25 one-time, up to 100 testers, minimal review) — Google's 14-day/12-tester closed-testing requirement for new personal accounts applies only to *public* publishing, not internal track.
- Or skip Play entirely: EAS produces a **signed APK** that sideloads directly onto the client's Android devices with no account. Acceptable for v1.
- Declare `RECORD_AUDIO` permission and request it at runtime.

### 14.3 Both platforms

- EAS manages signing certificates/keystores automatically.
- **Privacy policy page** (one static page: audio stored on Cloudflare R2, transcripts on Railway Postgres, processed via Sarvam and Anthropic APIs, not sold or shared): required only for TestFlight *external* testing or Play store tracks. Defer until then, but generating it early is cheap.
- Store **data-safety / privacy labels** (if ever on store tracks): declare honestly — audio recordings, user-provided names, third-party API processing.
- If the app ever goes to the public App Store: recording apps get extra scrutiny (clear recording indicators, privacy policy). Recording-consent law varies by jurisdiction; India generally permits recording conversations one is party to, but this is the client's decision to confirm for his context — not a technical question.
- **Dev-loop during build:** use an Expo development build on a real iPhone (and a real +91 SIM for auth testing). Audio recording, background sync, and network-drop behavior cannot be validated in a simulator.

### 14.4 Remaining publishing checklist

- [x] Apple Developer account — available
- [ ] Google Play $25 — only if Play internal track is preferred over sideloading (can defer)
- [ ] Firebase project (auth + FCM), Blaze plan — ~30 min; or defer with §13.1 device-token shortcut
- [ ] Privacy policy page — defer until external testers / store tracks
- [ ] Test OTP + recording + sync on real devices with Indian SIM

---

## 15. Invariants (test these)

1. Kill the app mid-recording → audio up to that point survives.
2. Kill connectivity mid-upload → resume loses ≤ 5 MB of progress, survives app restart.
3. Duplicate any API call → no duplicate meetings, no double transcription charges.
4. Sarvam fails 3× then succeeds → transcript appears, no data loss, no duplicate segments.
5. Analysis fails after transcription succeeded → only analysis retries.
6. Every quote in every summary plays the correct audio moment.
7. A quote string not present verbatim in the transcript is rejected by the worker validator.
8. Q&A with no relevant content answers "no recorded conversations mention this" — never general knowledge.
9. Roll-up structured_facts equal the union of child facts (numbers/commitments unchanged).
10. Local audio is deleted only after server confirms transcription success.
