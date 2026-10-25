-- Automated billing: Stripe customer per client, enquiry disputes, and one invoice per client per month

ALTER TABLE clients
  ADD COLUMN stripe_customer_id TEXT UNIQUE,
  ADD COLUMN payment_ready BOOLEAN NOT NULL DEFAULT FALSE;

-- a client can dispute an enquiry within a few days; an admin accepts (not billed) or rejects it
ALTER TABLE leads
  ADD COLUMN dispute_state TEXT CHECK (dispute_state IN ('open', 'accepted', 'rejected')),
  ADD COLUMN dispute_reason TEXT,
  ADD COLUMN disputed_at TIMESTAMPTZ;
CREATE INDEX leads_open_dispute_idx ON leads (client_id) WHERE dispute_state = 'open';

-- UNIQUE (client_id, period) is what stops a client ever being invoiced twice for the same month
CREATE TABLE invoices (
  id SERIAL PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  period TEXT NOT NULL,                       -- 'YYYY-MM'
  quantity INTEGER NOT NULL,
  unit_pence INTEGER NOT NULL,
  total_pence INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('creating', 'draft', 'open', 'paid', 'failed', 'void', 'skipped')),
  stripe_invoice_id TEXT UNIQUE,
  hosted_url TEXT,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  paid_at TIMESTAMPTZ,
  stripe_event_at TIMESTAMPTZ,                -- newest Stripe event applied, so late or repeated events can't undo a newer state
  UNIQUE (client_id, period)
);
