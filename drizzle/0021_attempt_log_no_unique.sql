-- Enforce one delivery_attempts row per (delivery_log_id, attempt_no).
--
-- The post-send persistence path retries its transaction after an ambiguous
-- failure. Without this constraint a retry could insert a second attempt row
-- for the same logical attempt, inflating countAttemptsByLog and shortening
-- the effective retry budget. With the unique index, insertDeliveryAttempt's
-- ON CONFLICT DO NOTHING makes the retry idempotent.
--
-- Any pre-existing duplicates (keeping the most recent) are removed first.

WITH ranked AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY "delivery_log_id", "attempt_no"
      ORDER BY "created_at" DESC, "id" DESC
    ) AS rn
  FROM "delivery_attempts"
)
DELETE FROM "delivery_attempts"
USING ranked
WHERE "delivery_attempts"."id" = ranked.id
  AND ranked.rn > 1;

CREATE UNIQUE INDEX "idx_attempt_log_no" ON "delivery_attempts" USING btree ("delivery_log_id", "attempt_no");
