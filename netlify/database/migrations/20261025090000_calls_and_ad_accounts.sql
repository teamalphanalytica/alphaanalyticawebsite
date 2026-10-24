-- Call tracking numbers, the call log, and the ad-account ids used to match incoming ad stats

ALTER TABLE clients ADD COLUMN call_min_seconds INTEGER NOT NULL DEFAULT 30;
ALTER TABLE clients ADD COLUMN google_customer_id TEXT;
ALTER TABLE clients ADD COLUMN meta_ad_account_id TEXT;
CREATE UNIQUE INDEX clients_google_customer_idx ON clients (google_customer_id) WHERE google_customer_id IS NOT NULL;
CREATE UNIQUE INDEX clients_meta_account_idx ON clients (meta_ad_account_id) WHERE meta_ad_account_id IS NOT NULL;

-- a call that lasts long enough becomes an enquiry; call_sid makes that safe to repeat
ALTER TABLE leads ADD COLUMN call_sid TEXT UNIQUE;

CREATE TABLE tracking_numbers (
  id SERIAL PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  number TEXT NOT NULL UNIQUE,      -- E.164: the number callers dial
  forward_to TEXT NOT NULL,         -- E.164: the client's real phone
  label TEXT NOT NULL,              -- where it is shown, e.g. 'Google ads'
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX tracking_numbers_client_idx ON tracking_numbers (client_id);

CREATE TABLE calls (
  id SERIAL PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  tracking_number_id INTEGER REFERENCES tracking_numbers(id) ON DELETE SET NULL,
  call_sid TEXT NOT NULL UNIQUE,
  from_number TEXT,
  label TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status TEXT NOT NULL DEFAULT 'ringing',
  duration_seconds INTEGER
);
CREATE INDEX calls_client_started_idx ON calls (client_id, started_at DESC);
