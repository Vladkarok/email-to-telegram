CREATE UNIQUE INDEX IF NOT EXISTS "idx_manual_billing_events_user_payment_ref"
  ON "manual_billing_events" ("telegram_user_id","payment_reference")
  WHERE telegram_user_id IS NOT NULL AND payment_reference IS NOT NULL;
