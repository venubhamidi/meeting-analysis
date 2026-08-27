-- Junk gate: recordings that are not worth transcribing.
--
-- The audio is still uploaded and kept forever (§4.1); this only records that
-- the pipeline declined to spend money on it. `force_transcribe` lets a human
-- overrule the gate without deleting and re-uploading.

ALTER TABLE meetings ADD COLUMN skip_reason TEXT;
ALTER TABLE meetings ADD COLUMN force_transcribe BOOLEAN NOT NULL DEFAULT false;
