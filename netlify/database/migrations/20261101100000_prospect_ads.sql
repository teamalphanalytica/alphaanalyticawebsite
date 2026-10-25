-- What we know about a prospect's advertising: checked by hand in the Google and Meta public ad libraries
ALTER TABLE prospects
  ADD COLUMN ads_google TEXT NOT NULL DEFAULT 'unknown' CHECK (ads_google IN ('unknown','yes','no')),
  ADD COLUMN ads_meta   TEXT NOT NULL DEFAULT 'unknown' CHECK (ads_meta   IN ('unknown','yes','no'));
