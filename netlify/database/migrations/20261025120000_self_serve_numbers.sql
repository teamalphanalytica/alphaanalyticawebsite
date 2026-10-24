-- Numbers a customer sets up themselves: at most one per client, and a short-lived
-- placeholder row stops a double click buying two numbers.
ALTER TABLE tracking_numbers ADD COLUMN self_serve BOOLEAN NOT NULL DEFAULT FALSE;
CREATE UNIQUE INDEX tracking_numbers_one_self_serve_idx ON tracking_numbers (client_id) WHERE self_serve;
