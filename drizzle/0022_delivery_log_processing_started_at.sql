-- Track when the primary delivery path begins processing a delivery log.
--
-- The retry worker uses this to distinguish a delivery that is actively in
-- progress from one stranded by a crashed process: a "processing" row is only
-- eligible for retry once processing_started_at is stale (or NULL, for rows
-- that predate this column).

ALTER TABLE "delivery_logs"
  ADD COLUMN IF NOT EXISTS "processing_started_at" timestamptz;
