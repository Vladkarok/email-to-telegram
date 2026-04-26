ALTER TABLE "organizations" DROP CONSTRAINT "chk_org_subscription_status";--> statement-breakpoint
ALTER TABLE "organizations"
ADD CONSTRAINT "chk_org_subscription_status"
CHECK ("organizations"."subscription_status" in ('free', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'incomplete', 'incomplete_expired'));--> statement-breakpoint

ALTER TABLE "organization_usage_months"
ADD COLUMN "egress_bytes" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint

ALTER TABLE "organization_usage_months"
ADD CONSTRAINT "chk_org_usage_egress_nonnegative"
CHECK ("organization_usage_months"."egress_bytes" >= 0);
