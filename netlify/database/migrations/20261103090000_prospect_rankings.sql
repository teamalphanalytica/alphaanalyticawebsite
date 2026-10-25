-- Where a prospect shows up on Google for the searches their customers make
ALTER TABLE prospects ADD COLUMN rankings JSONB NOT NULL DEFAULT '[]'::jsonb;   -- [{query, bucket, position, map_pack, source, checked_at}]
