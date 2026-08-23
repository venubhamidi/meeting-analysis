/**
 * Schema migrations, as plain SQL strings with no runtime dependency on
 * expo-sqlite, so they can be executed against node:sqlite in tests.
 * Index in array + 1 == PRAGMA user_version after it has been applied.
 */
export const MIGRATIONS: string[] = [
  // 1: initial schema (SPEC.md §4.2)
  `
  CREATE TABLE recordings (
    id TEXT PRIMARY KEY,              -- client-generated UUID
    created_at TEXT NOT NULL,         -- ISO8601
    duration_seconds INTEGER,
    file_path TEXT NOT NULL,          -- local directory holding this recording's segments
    file_size_bytes INTEGER,
    state TEXT NOT NULL DEFAULT 'recorded',
      -- recording | recorded | queued | uploading | uploaded | transcribing | analyzed | synced | stuck
    upload_id TEXT,                   -- R2 multipart uploadId
    parts_total INTEGER,
    parts_completed TEXT,             -- JSON array of completed part numbers
    attempts INTEGER DEFAULT 0,
    first_attempt_at TEXT,            -- ISO8601 of first upload attempt; drives the 24h stuck rule
    next_retry_at TEXT,
    last_error TEXT,
    wifi_only INTEGER DEFAULT 1,      -- per-recording cellular override
    notes_text TEXT,
    location TEXT,
    tags TEXT                         -- JSON array
  );

  -- Segment-safe recording: one row per finalized ~60s file (SPEC.md §4.1).
  CREATE TABLE recording_segments (
    recording_id TEXT NOT NULL REFERENCES recordings(id),
    seq INTEGER NOT NULL,
    file_path TEXT NOT NULL,
    duration_ms INTEGER,              -- null for a segment adopted by crash recovery
    size_bytes INTEGER,
    PRIMARY KEY (recording_id, seq)
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
  `,
];
