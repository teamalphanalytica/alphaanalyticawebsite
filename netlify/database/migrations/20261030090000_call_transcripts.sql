-- Call recordings, transcripts and AI summaries, plus indexes for the admin command centre

ALTER TABLE calls
  ADD COLUMN recording_sid TEXT UNIQUE,
  ADD COLUMN recording_seconds INTEGER,
  ADD COLUMN transcript_sid TEXT UNIQUE,
  ADD COLUMN transcript_status TEXT,           -- queued, in-progress, completed, failed
  ADD COLUMN transcript JSONB,                 -- [{speaker: 'caller'|'business', text, start}]
  ADD COLUMN transcript_error TEXT,
  ADD COLUMN summary JSONB,                    -- {summary, outcome, genuine, sentiment, follow_up}
  ADD COLUMN summarised_at TIMESTAMPTZ,
  ADD COLUMN media_deleted_at TIMESTAMPTZ;     -- recording and transcript wiped after the retention period

CREATE INDEX IF NOT EXISTS calls_started_idx ON calls (started_at DESC);
CREATE INDEX IF NOT EXISTS calls_pending_transcript_idx ON calls (transcript_status) WHERE transcript_sid IS NOT NULL AND transcript_status IS DISTINCT FROM 'completed';
CREATE INDEX IF NOT EXISTS leads_received_idx ON leads (received_at DESC);
CREATE INDEX IF NOT EXISTS leads_client_received_idx ON leads (client_id, received_at DESC);

-- small key/value store for things we set up once (like the Twilio transcription service id)
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
