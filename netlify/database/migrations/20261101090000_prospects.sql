-- Manchester prospecting: businesses we might sell to, what we saw on their website, and the proposal we wrote

CREATE TABLE IF NOT EXISTS prospects (
  id           BIGSERIAL PRIMARY KEY,
  dedupe_key   TEXT NOT NULL UNIQUE,           -- website host, or name + phone when they have no website
  name         TEXT NOT NULL,
  niche        TEXT,
  address      TEXT,
  phone        TEXT,
  website      TEXT,
  source       TEXT NOT NULL DEFAULT 'osm',    -- osm (OpenStreetMap) or manual
  entity_type  TEXT NOT NULL DEFAULT 'unknown' CHECK (entity_type IN ('unknown','company','sole_trader')),
  status       TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','to_call','contacted','replied','won','lost','skip')),
  notes        TEXT NOT NULL DEFAULT '',
  audit        JSONB,                          -- what we saw on the website: {checks, issues, score}
  score        INTEGER,                        -- 0 to 100, lower means more we can help with
  proposition  JSONB,                          -- the written proposal and call script
  proposition_by TEXT,                         -- claude or template
  batch_date   DATE NOT NULL DEFAULT CURRENT_DATE,
  found_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  contacted_at TIMESTAMPTZ,
  follow_up_on DATE
);
CREATE INDEX IF NOT EXISTS prospects_batch_idx ON prospects (batch_date DESC, score);
CREATE INDEX IF NOT EXISTS prospects_status_idx ON prospects (status);
