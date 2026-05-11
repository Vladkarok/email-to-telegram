-- Remove duplicate (telegram_user_id, payment_reference) rows, keeping oldest.
-- Needed because the previous schema only enforced (organization_id, payment_reference)
-- uniqueness, so the same user+reference could exist in multiple orgs historically.
DELETE FROM "manual_billing_events"
WHERE id IN (
  SELECT id
  FROM (
    SELECT id,
           ROW_NUMBER() OVER (
             PARTITION BY telegram_user_id, payment_reference
             ORDER BY created_at ASC
           ) AS rn
    FROM "manual_billing_events"
    WHERE telegram_user_id IS NOT NULL
      AND payment_reference IS NOT NULL
  ) t
  WHERE rn > 1
);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_manual_billing_events_user_payment_ref"
  ON "manual_billing_events" ("telegram_user_id","payment_reference")
  WHERE telegram_user_id IS NOT NULL AND payment_reference IS NOT NULL;
