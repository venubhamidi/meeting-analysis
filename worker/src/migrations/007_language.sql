-- The recogniser detects the language (sarvam.ts DEFAULT_LANGUAGE = 'unknown')
-- and reports it with a probability, but until now both were only logged. A
-- dashboard that filters by language needs them as columns, and a low
-- probability is the signal that a meeting may be filed under the wrong one.

ALTER TABLE meetings ADD COLUMN language TEXT;               -- BCP-47ish, as Sarvam returns it: te-IN, hi-IN, ta-IN
ALTER TABLE meetings ADD COLUMN language_probability REAL;   -- null when the recogniser did not report one

CREATE INDEX meetings_language_created_at_idx ON meetings (language, created_at DESC);
