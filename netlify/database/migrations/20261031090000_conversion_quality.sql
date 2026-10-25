-- Better signals back to Google: real values, a separate "became a customer" conversion,
-- holding back enquiries until they are confirmed genuine, and crediting phone calls to ad clicks.

ALTER TABLE leads ADD COLUMN customer_at TIMESTAMPTZ;
ALTER TABLE leads ADD COLUMN google_customer_sent_at TIMESTAMPTZ;

ALTER TABLE clients ADD COLUMN google_customer_conversion_name TEXT;
ALTER TABLE clients ADD COLUMN customer_value_pence INTEGER;

-- Ad click ids carried from a tap-to-call on the website to the call itself
ALTER TABLE calls ADD COLUMN gclid TEXT;
ALTER TABLE calls ADD COLUMN gbraid TEXT;
ALTER TABLE calls ADD COLUMN wbraid TEXT;
ALTER TABLE calls ADD COLUMN fbc TEXT;
ALTER TABLE calls ADD COLUMN fbp TEXT;
ALTER TABLE calls ADD COLUMN page_url TEXT;

CREATE TABLE call_clicks (
  id BIGSERIAL PRIMARY KEY,
  number TEXT NOT NULL,
  gclid TEXT,
  gbraid TEXT,
  wbraid TEXT,
  fbc TEXT,
  fbp TEXT,
  page_url TEXT,
  clicked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  used_at TIMESTAMPTZ
);
CREATE INDEX call_clicks_number_idx ON call_clicks (number, clicked_at DESC);

CREATE INDEX leads_google_customer_pending_idx ON leads (customer_at)
  WHERE status = 'customer' AND google_customer_sent_at IS NULL AND gclid IS NOT NULL;
