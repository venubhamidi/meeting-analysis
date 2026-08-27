-- Two lanes through the pipeline.
--
-- Most recordings can wait for the overnight batch, which costs half as much.
-- Some cannot: a meeting the surveyor flags as important, or one the office
-- asks for from the dashboard. Those run immediately at full price.
--
-- priority 0 = normal, swept into the nightly batch
-- priority 1 = run now, on the live API

ALTER TABLE jobs ADD COLUMN priority INT NOT NULL DEFAULT 0;
CREATE INDEX ON jobs (status, priority DESC, next_retry_at);

ALTER TABLE meetings ADD COLUMN priority INT NOT NULL DEFAULT 0;
