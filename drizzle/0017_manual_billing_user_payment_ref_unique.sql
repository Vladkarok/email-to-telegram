-- Lock the table to prevent concurrent inserts between the duplicate check and
-- the unique index creation, making rollout safe on a live database.
LOCK TABLE "manual_billing_events" IN EXCLUSIVE MODE;

-- Refuse to apply the unique index if duplicate (telegram_user_id, payment_reference)
-- rows already exist. Duplicates can only arise if the same user+reference was granted
-- to two different organizations under the old schema. That state requires manual
-- operator reconciliation before this constraint can be enforced safely.
DO $$
DECLARE
  dup_count INT;
BEGIN
  SELECT COUNT(*) INTO dup_count
  FROM (
    SELECT telegram_user_id, payment_reference
    FROM "manual_billing_events"
    WHERE telegram_user_id IS NOT NULL
      AND payment_reference IS NOT NULL
    GROUP BY telegram_user_id, payment_reference
    HAVING COUNT(*) > 1
  ) t;
  IF dup_count > 0 THEN
    RAISE EXCEPTION
      'Migration 0017 blocked: % duplicate (telegram_user_id, payment_reference) group(s) '
      'found in manual_billing_events. Reconcile the affected organizations manually '
      'and remove the duplicate rows before re-running this migration.',
      dup_count;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "idx_manual_billing_events_user_payment_ref"
  ON "manual_billing_events" ("telegram_user_id","payment_reference")
  WHERE telegram_user_id IS NOT NULL AND payment_reference IS NOT NULL;
