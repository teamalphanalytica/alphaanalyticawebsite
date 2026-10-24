-- Automation: report drafts, client intake, and ad-connection status

ALTER TABLE reports ADD COLUMN published BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE reports ADD COLUMN auto BOOLEAN NOT NULL DEFAULT FALSE;
-- one automatic draft per client per week, however many times the job runs
CREATE UNIQUE INDEX reports_one_auto_per_week_idx ON reports (client_id, week_start) WHERE auto;

ALTER TABLE clients ADD COLUMN intake JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE clients ADD COLUMN google_last_push TIMESTAMPTZ;
ALTER TABLE clients ADD COLUMN meta_last_sync TIMESTAMPTZ;
ALTER TABLE clients ADD COLUMN meta_last_error TEXT;
