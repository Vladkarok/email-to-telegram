-- Lock the table to prevent concurrent inserts between the duplicate check and
-- the unique index creation, making rollout safe on a live database.
LOCK TABLE "manual_billing_events" IN EXCLUSIVE MODE;

-- Refuse to apply the unique index if duplicate payment_reference rows already
-- exist across different organizations. Duplicates require manual reconciliation
-- before this constraint can be enforced safely.
DO $$
DECLARE
  dup_count INT;
BEGIN
  SELECT COUNT(*) INTO dup_count
  FROM (
    SELECT payment_reference
    FROM "manual_billing_events"
    WHERE payment_reference IS NOT NULL
    GROUP BY payment_reference
    HAVING COUNT(*) > 1
  ) t;
  IF dup_count > 0 THEN
    RAISE EXCEPTION
      'Migration 0018 blocked: % duplicate payment_reference value(s) '
      'found across different organizations in manual_billing_events. '
      'Reconcile the affected rows manually and remove duplicates before '
      're-running this migration.',
      dup_count;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "idx_manual_billing_events_payment_ref"
  ON "manual_billing_events" ("payment_reference")
  WHERE payment_reference IS NOT NULL;
