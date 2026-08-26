-- Per-segment upload registry (phase 2).
--
-- SPEC.md §4.3 assumes one multipart upload per recording, but R2 requires
-- every part except the last to be at least 5 MiB and all of equal size, and
-- the app's segments are ~480 KB. So each segment is its own R2 object,
-- uploaded with a plain presigned PUT; the worker concatenates them before
-- transcription. A failed upload retries one segment (~480 KB) rather than a
-- 5 MiB part, which is stricter than invariant #2 requires.

CREATE TABLE meeting_segments (
  meeting_id UUID NOT NULL REFERENCES meetings(id),
  seq INT NOT NULL,
  audio_key TEXT NOT NULL,          -- R2 object key
  size_bytes BIGINT,
  duration_ms INT,
  uploaded_at TIMESTAMPTZ,          -- null until the client confirms the PUT
  PRIMARY KEY (meeting_id, seq)
);
CREATE INDEX ON meeting_segments (meeting_id) WHERE uploaded_at IS NULL;

-- How many segments the client says this recording has. Null while recording
-- is still in progress on the device; set when the client finalizes the upload.
ALTER TABLE meetings ADD COLUMN segments_total INT;
