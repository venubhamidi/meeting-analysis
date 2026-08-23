-- Phase 2 (SPEC.md §11.2): upload + transcription.
-- Tables for later phases (analyses, summaries, chunks, meeting_participants)
-- arrive with the phases that use them.

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
CREATE INDEX ON meetings (user_id, created_at DESC);

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
-- Invariant #4: a retried transcription must not double-insert segments.
CREATE UNIQUE INDEX ON transcript_segments (meeting_id, seq);

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
