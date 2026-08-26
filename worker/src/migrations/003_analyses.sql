-- Phase 3: per-meeting analysis (SPEC.md §5, §6.2).

CREATE TABLE analyses (
  meeting_id UUID PRIMARY KEY REFERENCES meetings(id),
  telugu_summary TEXT,
  english_summary TEXT,
  quotes JSONB,           -- [{speaker_label, text_te (verbatim), text_en, start_ms, end_ms, segment_id}]
  sentiment JSONB,        -- per speaker and per topic
  action_items JSONB,     -- [{description, speaker_label, due_hint}]
  structured_facts JSONB, -- {people:[], commitments:[], amounts:[], dates:[], topics:[]}
  model TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
