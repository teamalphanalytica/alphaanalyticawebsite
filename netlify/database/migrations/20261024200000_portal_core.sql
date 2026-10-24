-- Alpha Analytica client portal: core tables

CREATE TABLE clients (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  sector TEXT,
  website_url TEXT,
  preview_url TEXT,
  -- secret used by the client's site/webhook to send enquiries to us
  ingest_key TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- which login (by email) belongs to which client
CREATE TABLE client_users (
  email TEXT PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE
);

CREATE TABLE build_steps (
  id SERIAL PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  title TEXT NOT NULL,
  detail TEXT,
  status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'doing', 'done')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX build_steps_client_idx ON build_steps (client_id, position);

CREATE TABLE leads (
  id SERIAL PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  type TEXT NOT NULL DEFAULT 'form' CHECK (type IN ('form', 'call')),
  name TEXT,
  email TEXT,
  phone TEXT,
  message TEXT,
  source TEXT,
  campaign TEXT,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'qualified', 'customer', 'spam')),
  value_pence INTEGER
);
CREATE INDEX leads_client_received_idx ON leads (client_id, received_at DESC);

-- one row per client, per day, per ad platform
CREATE TABLE ad_stats (
  id SERIAL PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  day DATE NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('google', 'meta')),
  spend_pence INTEGER NOT NULL DEFAULT 0,
  impressions INTEGER NOT NULL DEFAULT 0,
  clicks INTEGER NOT NULL DEFAULT 0,
  enquiries INTEGER NOT NULL DEFAULT 0,
  UNIQUE (client_id, day, platform)
);
CREATE INDEX ad_stats_client_day_idx ON ad_stats (client_id, day DESC);

CREATE TABLE reports (
  id SERIAL PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  week_start DATE NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX reports_client_week_idx ON reports (client_id, week_start DESC);
