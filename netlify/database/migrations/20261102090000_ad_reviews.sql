-- Weekly AI review of each client's advertising: what's working, what to change, what to test next
CREATE TABLE IF NOT EXISTS ad_reviews (
  id          BIGSERIAL PRIMARY KEY,
  client_id   BIGINT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  week_start  DATE NOT NULL,
  review      JSONB NOT NULL,        -- {headline, working[], not_working[], changes[{action, why}], test_next, client_note}
  facts       JSONB NOT NULL,        -- the numbers the review was written from, so it can be checked
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (client_id, week_start)
);
