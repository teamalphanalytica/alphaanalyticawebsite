-- Price per genuine enquiry (for the monthly billing summary) and report email tracking
ALTER TABLE clients ADD COLUMN price_per_enquiry_pence INTEGER;
ALTER TABLE reports ADD COLUMN emailed_at TIMESTAMPTZ;
