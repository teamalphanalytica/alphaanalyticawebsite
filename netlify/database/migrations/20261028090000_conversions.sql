-- Sending genuine enquiries back to Google and Meta as conversions

ALTER TABLE leads ADD COLUMN gclid TEXT;
ALTER TABLE leads ADD COLUMN gbraid TEXT;
ALTER TABLE leads ADD COLUMN wbraid TEXT;
ALTER TABLE leads ADD COLUMN fbc TEXT;
ALTER TABLE leads ADD COLUMN fbp TEXT;
ALTER TABLE leads ADD COLUMN ip TEXT;
ALTER TABLE leads ADD COLUMN user_agent TEXT;
ALTER TABLE leads ADD COLUMN page_url TEXT;
ALTER TABLE leads ADD COLUMN google_sent_at TIMESTAMPTZ;
ALTER TABLE leads ADD COLUMN meta_sent_at TIMESTAMPTZ;
ALTER TABLE leads ADD COLUMN meta_error TEXT;

ALTER TABLE clients ADD COLUMN meta_pixel_id TEXT;
ALTER TABLE clients ADD COLUMN google_conversion_name TEXT NOT NULL DEFAULT 'Portal enquiry';

CREATE INDEX leads_meta_pending_idx ON leads (received_at) WHERE meta_sent_at IS NULL;
CREATE INDEX leads_google_pending_idx ON leads (received_at) WHERE google_sent_at IS NULL AND gclid IS NOT NULL;
