-- Drop the organization tenant concept. Chats own aliases; users own
-- billing, plan, quotas, custom inbound domains.
--
-- This migration is destructive: organization_* tables and FK columns are
-- removed without backfill (no production user data to preserve).

-- ─── 1) Billing fields move from organizations onto users ───────────────────
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "plan_code" varchar(32) NOT NULL DEFAULT 'free',
  ADD COLUMN IF NOT EXISTS "subscription_status" varchar(32) NOT NULL DEFAULT 'free',
  ADD COLUMN IF NOT EXISTS "stripe_customer_id" varchar(255),
  ADD COLUMN IF NOT EXISTS "stripe_subscription_id" varchar(255),
  ADD COLUMN IF NOT EXISTS "trial_ends_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "current_period_start" timestamptz,
  ADD COLUMN IF NOT EXISTS "current_period_end" timestamptz,
  ADD COLUMN IF NOT EXISTS "paid_through_at" timestamptz;

ALTER TABLE "users"
  ADD CONSTRAINT "chk_user_plan_code"
    CHECK ("plan_code" IN ('free', 'personal', 'pro', 'team', 'business')),
  ADD CONSTRAINT "chk_user_subscription_status"
    CHECK ("subscription_status" IN ('free', 'trialing', 'active', 'paused', 'past_due', 'canceled', 'unpaid', 'incomplete', 'incomplete_expired'));

CREATE UNIQUE INDEX IF NOT EXISTS "idx_user_stripe_customer"
  ON "users" ("stripe_customer_id");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_user_stripe_subscription"
  ON "users" ("stripe_subscription_id");

-- ─── 2) email_addresses: drop organization_id ───────────────────────────────
-- Aliases were already addressable by (chat_id, created_by). organization_id
-- was redundant tenant metadata.
DROP INDEX IF EXISTS "idx_alias_org";
ALTER TABLE "email_addresses" DROP COLUMN IF EXISTS "organization_id";
-- Quota lookups now hit aliases by owning user; back this with an index.
CREATE INDEX IF NOT EXISTS "idx_alias_created_by"
  ON "email_addresses" ("created_by");

-- ─── 3) chats: drop organization_id (the chat IS the workspace) ─────────────
ALTER TABLE "chats" DROP COLUMN IF EXISTS "organization_id";

-- ─── 4) delivery_logs: organization_id → user_id ────────────────────────────
DROP INDEX IF EXISTS "idx_log_org_time";
ALTER TABLE "delivery_logs" DROP COLUMN IF EXISTS "organization_id";
ALTER TABLE "delivery_logs"
  ADD COLUMN IF NOT EXISTS "user_id" bigint REFERENCES "users"("id");
CREATE INDEX IF NOT EXISTS "idx_log_user_time"
  ON "delivery_logs" ("user_id", "received_at");

-- ─── 5) inbound_domains: organization_id → user_id ─────────────────────────
-- User owns the custom domain. Shared domains keep user_id NULL.
DROP INDEX IF EXISTS "idx_inbound_domain_org_status";
ALTER TABLE "inbound_domains" DROP CONSTRAINT IF EXISTS "chk_inbound_domain_ownership";
ALTER TABLE "inbound_domains" DROP COLUMN IF EXISTS "organization_id";
ALTER TABLE "inbound_domains"
  ADD COLUMN IF NOT EXISTS "user_id" bigint REFERENCES "users"("id") ON DELETE CASCADE;
ALTER TABLE "inbound_domains"
  ADD CONSTRAINT "chk_inbound_domain_ownership"
    CHECK (("kind" = 'shared' AND "user_id" IS NULL)
        OR ("kind" = 'custom' AND "user_id" IS NOT NULL));
CREATE INDEX IF NOT EXISTS "idx_inbound_domain_user_status"
  ON "inbound_domains" ("user_id", "status");

-- ─── 6) Replace organization_storage_usage with user_storage_usage ──────────
DROP TABLE IF EXISTS "organization_storage_usage";
CREATE TABLE "user_storage_usage" (
  "user_id" bigint PRIMARY KEY REFERENCES "users"("id") ON DELETE CASCADE,
  "raw_email_bytes" bigint NOT NULL DEFAULT 0,
  "attachment_bytes" bigint NOT NULL DEFAULT 0,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "chk_user_storage_raw_nonnegative" CHECK ("raw_email_bytes" >= 0),
  CONSTRAINT "chk_user_storage_attachment_nonnegative" CHECK ("attachment_bytes" >= 0)
);

-- ─── 7) Replace organization_usage_months with user_usage_months ────────────
DROP TABLE IF EXISTS "organization_usage_months";
CREATE TABLE "user_usage_months" (
  "user_id" bigint NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "month" varchar(7) NOT NULL,
  "delivered_count" integer NOT NULL DEFAULT 0,
  "rejected_count" integer NOT NULL DEFAULT 0,
  "egress_bytes" bigint NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("user_id", "month"),
  CONSTRAINT "chk_user_usage_month" CHECK ("month" ~ '^[0-9]{4}-[0-9]{2}$'),
  CONSTRAINT "chk_user_usage_delivered_nonnegative" CHECK ("delivered_count" >= 0),
  CONSTRAINT "chk_user_usage_rejected_nonnegative" CHECK ("rejected_count" >= 0),
  CONSTRAINT "chk_user_usage_egress_nonnegative" CHECK ("egress_bytes" >= 0)
);

-- ─── 8) manual_billing_events: telegram_user_id NOT NULL, drop org_id ───────
DROP INDEX IF EXISTS "idx_manual_billing_events_org_created";
DROP INDEX IF EXISTS "idx_manual_billing_events_org_payment_ref";
-- Existing rows without telegram_user_id cannot be salvaged; delete them.
DELETE FROM "manual_billing_events" WHERE "telegram_user_id" IS NULL;
ALTER TABLE "manual_billing_events"
  ALTER COLUMN "telegram_user_id" SET NOT NULL;
ALTER TABLE "manual_billing_events" DROP COLUMN IF EXISTS "organization_id";
CREATE INDEX IF NOT EXISTS "idx_manual_billing_events_user_created"
  ON "manual_billing_events" ("telegram_user_id", "created_at");

-- ─── 9) Drop organization_members and organizations last ────────────────────
DROP TABLE IF EXISTS "organization_members";
DROP TABLE IF EXISTS "organizations";
