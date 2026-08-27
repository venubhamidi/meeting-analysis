-- Phase 4: semantic search over transcripts (SPEC.md §5, §6.1 stage 3).
--
-- Chatbot search needs retrievable, embedded text; nothing in 001-005 stores a
-- vector, so this is the gap between the current schema and that capability.
--
-- SPEC.md §5 also gives chunks a summary_id referencing the roll-up `summaries`
-- table. Roll-ups are out of the current scope, so that column and its foreign
-- key are omitted rather than left pointing at a table that does not exist.
--
-- 1024 dimensions matches Xenova/bge-m3, the self-hosted embedder (SCALING.md).
--
-- The embedding column is added conditionally because the hermetic test database
-- (PGlite) ships no pgvector build, and an unconditional `vector(1024)` would
-- fail every test that migrates. Postgres — production and the mi-pg-test
-- container — has the extension and gets the column and its index. Anything
-- touching embeddings must therefore run against a real Postgres, not PGlite.

CREATE TABLE chunks (
  id BIGSERIAL PRIMARY KEY,
  meeting_id UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  chunk_type TEXT NOT NULL,               -- transcript | summary
  text TEXT NOT NULL,                     -- includes speaker labels when set
  meta JSONB,                             -- {speaker_label, start_ms, end_ms, seq}
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Re-embedding a meeting must replace its chunks, not duplicate them (§6.1
-- idempotency), so deletes are by meeting and need the index.
CREATE INDEX chunks_meeting_id_idx ON chunks (meeting_id);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'vector') THEN
    ALTER TABLE chunks ADD COLUMN embedding vector(1024);
    CREATE INDEX chunks_embedding_idx ON chunks USING hnsw (embedding vector_cosine_ops);
  ELSE
    RAISE NOTICE 'pgvector not installed: chunks.embedding omitted (expected only on PGlite)';
  END IF;
END $$;
