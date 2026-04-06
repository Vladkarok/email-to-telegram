-- Remove duplicate delivery_log rows that would violate the new unique indexes.
-- For each conflicting (email_address_id, message_id_header) group, keep only
-- the row with the latest received_at (largest id used as tie-breaker).
DELETE FROM "delivery_logs"
WHERE id IN (
  SELECT id FROM (
    SELECT id,
           ROW_NUMBER() OVER (
             PARTITION BY email_address_id, message_id_header
             ORDER BY received_at DESC, id DESC
           ) AS rn
    FROM "delivery_logs"
    WHERE message_id_header IS NOT NULL
  ) ranked
  WHERE rn > 1
);--> statement-breakpoint

-- Same dedup for (email_address_id, body_sha256).
DELETE FROM "delivery_logs"
WHERE id IN (
  SELECT id FROM (
    SELECT id,
           ROW_NUMBER() OVER (
             PARTITION BY email_address_id, body_sha256
             ORDER BY received_at DESC, id DESC
           ) AS rn
    FROM "delivery_logs"
    WHERE body_sha256 IS NOT NULL
  ) ranked
  WHERE rn > 1
);--> statement-breakpoint

CREATE UNIQUE INDEX "idx_log_dedup_msgid" ON "delivery_logs" USING btree ("email_address_id","message_id_header") WHERE message_id_header IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_log_dedup_bodyhash" ON "delivery_logs" USING btree ("email_address_id","body_sha256") WHERE body_sha256 IS NOT NULL;
