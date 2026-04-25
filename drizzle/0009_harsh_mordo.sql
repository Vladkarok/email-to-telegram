CREATE TABLE "billing_webhook_events" (
	"event_id" varchar(255) PRIMARY KEY NOT NULL,
	"event_type" varchar(255) NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inbound_domains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"domain" varchar(255) NOT NULL,
	"kind" varchar(20) NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"verification_token" varchar(255),
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_inbound_domain_kind" CHECK ("inbound_domains"."kind" in ('shared', 'custom')),
	CONSTRAINT "chk_inbound_domain_status" CHECK ("inbound_domains"."status" in ('active', 'pending', 'disabled')),
	CONSTRAINT "chk_inbound_domain_ownership" CHECK (("inbound_domains"."kind" = 'shared' and "inbound_domains"."organization_id" is null) or ("inbound_domains"."kind" = 'custom' and "inbound_domains"."organization_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "organization_members" (
	"organization_id" uuid NOT NULL,
	"user_id" bigint NOT NULL,
	"role" varchar(20) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_members_organization_id_user_id_pk" PRIMARY KEY("organization_id","user_id"),
	CONSTRAINT "chk_org_member_role" CHECK ("organization_members"."role" in ('owner', 'admin', 'member'))
);
--> statement-breakpoint
CREATE TABLE "organization_storage_usage" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"raw_email_bytes" bigint DEFAULT 0 NOT NULL,
	"attachment_bytes" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_org_storage_raw_nonnegative" CHECK ("organization_storage_usage"."raw_email_bytes" >= 0),
	CONSTRAINT "chk_org_storage_attachment_nonnegative" CHECK ("organization_storage_usage"."attachment_bytes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "organization_usage_months" (
	"organization_id" uuid NOT NULL,
	"month" varchar(7) NOT NULL,
	"delivered_count" integer DEFAULT 0 NOT NULL,
	"rejected_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_usage_months_organization_id_month_pk" PRIMARY KEY("organization_id","month"),
	CONSTRAINT "chk_org_usage_month" CHECK ("organization_usage_months"."month" ~ '^[0-9]{4}-[0-9]{2}$'),
	CONSTRAINT "chk_org_usage_delivered_nonnegative" CHECK ("organization_usage_months"."delivered_count" >= 0),
	CONSTRAINT "chk_org_usage_rejected_nonnegative" CHECK ("organization_usage_months"."rejected_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"plan_code" varchar(32) DEFAULT 'free' NOT NULL,
	"subscription_status" varchar(32) DEFAULT 'free' NOT NULL,
	"stripe_customer_id" varchar(255),
	"stripe_subscription_id" varchar(255),
	"trial_ends_at" timestamp with time zone,
	"current_period_start" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_org_plan_code" CHECK ("organizations"."plan_code" in ('free', 'personal', 'pro', 'team', 'business')),
	CONSTRAINT "chk_org_subscription_status" CHECK ("organizations"."subscription_status" in ('free', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'incomplete'))
);
--> statement-breakpoint
DROP INDEX "idx_alias_local_part";--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "organization_id" uuid;--> statement-breakpoint
ALTER TABLE "delivery_logs" ADD COLUMN "organization_id" uuid;--> statement-breakpoint
ALTER TABLE "delivery_logs" ADD COLUMN "billable" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "email_addresses" ADD COLUMN "organization_id" uuid;--> statement-breakpoint
ALTER TABLE "email_addresses" ADD COLUMN "domain_id" uuid;--> statement-breakpoint
ALTER TABLE "inbound_domains" ADD CONSTRAINT "inbound_domains_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_storage_usage" ADD CONSTRAINT "organization_storage_usage_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_usage_months" ADD CONSTRAINT "organization_usage_months_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_inbound_domain_domain" ON "inbound_domains" USING btree ("domain");--> statement-breakpoint
CREATE INDEX "idx_inbound_domain_org_status" ON "inbound_domains" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "idx_org_member_user" ON "organization_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_org_stripe_customer" ON "organizations" USING btree ("stripe_customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_org_stripe_subscription" ON "organizations" USING btree ("stripe_subscription_id");--> statement-breakpoint
ALTER TABLE "chats" ADD CONSTRAINT "chats_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_logs" ADD CONSTRAINT "delivery_logs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_addresses" ADD CONSTRAINT "email_addresses_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_addresses" ADD CONSTRAINT "email_addresses_domain_id_inbound_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."inbound_domains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_log_org_time" ON "delivery_logs" USING btree ("organization_id","received_at");--> statement-breakpoint
CREATE INDEX "idx_alias_org" ON "email_addresses" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_alias_domain_local_part" ON "email_addresses" USING btree ("domain_id","local_part") WHERE "email_addresses"."domain_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_alias_local_part" ON "email_addresses" USING btree ("local_part") WHERE "email_addresses"."domain_id" is null;--> statement-breakpoint
CREATE OR REPLACE FUNCTION enforce_email_address_tenant_consistency()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	chat_org uuid;
	domain_kind varchar(20);
	domain_org uuid;
BEGIN
	SELECT organization_id INTO chat_org
	FROM chats
	WHERE id = NEW.chat_id;

	IF chat_org IS DISTINCT FROM NEW.organization_id THEN
		RAISE EXCEPTION 'email address organization_id must match chat organization_id';
	END IF;

	IF NEW.domain_id IS NOT NULL THEN
		SELECT kind, organization_id INTO domain_kind, domain_org
		FROM inbound_domains
		WHERE id = NEW.domain_id;

		IF NEW.organization_id IS NULL AND domain_kind = 'custom' THEN
			RAISE EXCEPTION 'legacy email address cannot use a custom domain';
		END IF;

		IF domain_kind = 'custom' AND domain_org <> NEW.organization_id THEN
			RAISE EXCEPTION 'email address organization_id must match custom domain organization_id';
		END IF;
	END IF;

	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER trg_email_address_tenant_consistency
BEFORE INSERT OR UPDATE OF organization_id, domain_id, chat_id
ON email_addresses
FOR EACH ROW
EXECUTE FUNCTION enforce_email_address_tenant_consistency();
