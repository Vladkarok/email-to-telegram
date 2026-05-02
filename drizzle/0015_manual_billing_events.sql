CREATE TABLE IF NOT EXISTS "manual_billing_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"telegram_user_id" bigint,
	"plan_code" varchar(32) NOT NULL,
	"subscription_status" varchar(32) NOT NULL,
	"paid_through_at" timestamp with time zone,
	"payment_reference" varchar(255),
	"note" varchar(1000),
	"kept_stripe_link" boolean DEFAULT false NOT NULL,
	"operator_source" varchar(64) DEFAULT 'cli' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_manual_billing_events_plan_code" CHECK ("manual_billing_events"."plan_code" in ('free', 'personal', 'pro', 'team', 'business')),
	CONSTRAINT "chk_manual_billing_events_subscription_status" CHECK ("manual_billing_events"."subscription_status" in ('free', 'active', 'canceled'))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "manual_billing_events" ADD CONSTRAINT "manual_billing_events_organization_id_organizations_id_fk"
   FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_manual_billing_events_org_created"
  ON "manual_billing_events" ("organization_id","created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_manual_billing_events_org_payment_ref"
  ON "manual_billing_events" ("organization_id","payment_reference")
  WHERE payment_reference is not null;
