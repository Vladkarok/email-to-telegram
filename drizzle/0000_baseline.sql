CREATE TABLE "users" (
	"id" bigint PRIMARY KEY NOT NULL,
	"username" varchar(255),
	"locale" varchar(16),
	"is_allowed" boolean DEFAULT false NOT NULL,
	"plan_code" varchar(32) DEFAULT 'free' NOT NULL,
	"subscription_status" varchar(32) DEFAULT 'free' NOT NULL,
	"stripe_customer_id" varchar(255),
	"stripe_subscription_id" varchar(255),
	"trial_ends_at" timestamp with time zone,
	"current_period_start" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"paid_through_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_user_plan_code" CHECK ("users"."plan_code" in ('free', 'personal', 'pro', 'team', 'business')),
	CONSTRAINT "chk_user_subscription_status" CHECK ("users"."subscription_status" in ('free', 'trialing', 'active', 'paused', 'past_due', 'canceled', 'unpaid', 'incomplete', 'incomplete_expired'))
);
--> statement-breakpoint
CREATE TABLE "inbound_domains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" bigint,
	"domain" varchar(255) NOT NULL,
	"kind" varchar(20) NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"verification_token" varchar(255),
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_inbound_domain_kind" CHECK ("inbound_domains"."kind" in ('shared', 'custom')),
	CONSTRAINT "chk_inbound_domain_status" CHECK ("inbound_domains"."status" in ('active', 'pending', 'disabled')),
	CONSTRAINT "chk_inbound_domain_ownership" CHECK (("inbound_domains"."kind" = 'shared' and "inbound_domains"."user_id" is null) or ("inbound_domains"."kind" = 'custom' and "inbound_domains"."user_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "chats" (
	"id" bigint PRIMARY KEY NOT NULL,
	"title" varchar(255) NOT NULL,
	"type" varchar(20) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "allow_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email_address_id" uuid NOT NULL,
	"match_type" varchar(20) NOT NULL,
	"match_value" varchar(320) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_addresses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"local_part" varchar(64) NOT NULL,
	"full_address" varchar(320) NOT NULL,
	"domain_id" uuid,
	"chat_id" bigint NOT NULL,
	"message_thread_id" bigint,
	"created_by" bigint NOT NULL,
	"label" varchar(64),
	"render_mode" varchar(20) DEFAULT 'plaintext' NOT NULL,
	"privacy_mode_enabled" boolean DEFAULT false NOT NULL,
	"body_dedup_enabled" boolean DEFAULT false NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"max_emails_hour" integer DEFAULT 60 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "delivery_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"delivery_log_id" uuid NOT NULL,
	"attempt_no" smallint NOT NULL,
	"target_chat_id" bigint NOT NULL,
	"target_thread_id" bigint,
	"telegram_message_id" bigint,
	"status" varchar(20) NOT NULL,
	"error_text" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "delivery_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email_address_id" uuid NOT NULL,
	"user_id" bigint,
	"message_id_header" varchar(998),
	"body_sha256" varchar(64),
	"body_dedup_applied" boolean DEFAULT false NOT NULL,
	"envelope_from" varchar(320),
	"header_from" varchar(320),
	"subject" text,
	"metadata_ciphertext" text,
	"metadata_encryption_mode" varchar(20) DEFAULT 'none' NOT NULL,
	"metadata_wrapped_dek" text,
	"metadata_kek_key_id" varchar(255),
	"metadata_encrypted_at" timestamp with time zone,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processing_started_at" timestamp with time zone,
	"raw_size_bytes" integer,
	"raw_email_path" varchar(512),
	"raw_email_encryption_mode" varchar(20) DEFAULT 'none' NOT NULL,
	"raw_email_wrapped_dek" text,
	"raw_email_kek_key_id" varchar(255),
	"raw_email_encrypted_at" timestamp with time zone,
	"has_attachments" boolean DEFAULT false NOT NULL,
	"final_status" varchar(20) DEFAULT 'received' NOT NULL,
	"billable" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "delivery_view_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"delivery_log_id" uuid NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"viewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attachment_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"attachment_id" uuid NOT NULL,
	"token" varchar(96) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"downloaded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"delivery_log_id" uuid NOT NULL,
	"original_filename" varchar(255),
	"content_type" varchar(127),
	"size_bytes" integer,
	"sha256" varchar(64),
	"storage_path" varchar(512) NOT NULL,
	"encryption_mode" varchar(20) DEFAULT 'none' NOT NULL,
	"wrapped_dek" text,
	"kek_key_id" varchar(255),
	"encrypted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_storage_usage" (
	"user_id" bigint PRIMARY KEY NOT NULL,
	"raw_email_bytes" bigint DEFAULT 0 NOT NULL,
	"attachment_bytes" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_user_storage_raw_nonnegative" CHECK ("user_storage_usage"."raw_email_bytes" >= 0),
	CONSTRAINT "chk_user_storage_attachment_nonnegative" CHECK ("user_storage_usage"."attachment_bytes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "billing_webhook_events" (
	"event_id" varchar(255) PRIMARY KEY NOT NULL,
	"event_type" varchar(255) NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "manual_billing_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"telegram_user_id" bigint NOT NULL,
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
CREATE TABLE "user_usage_months" (
	"user_id" bigint NOT NULL,
	"month" varchar(7) NOT NULL,
	"delivered_count" integer DEFAULT 0 NOT NULL,
	"rejected_count" integer DEFAULT 0 NOT NULL,
	"egress_bytes" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_usage_months_user_id_month_pk" PRIMARY KEY("user_id","month"),
	CONSTRAINT "chk_user_usage_month" CHECK ("user_usage_months"."month" ~ '^[0-9]{4}-[0-9]{2}$'),
	CONSTRAINT "chk_user_usage_delivered_nonnegative" CHECK ("user_usage_months"."delivered_count" >= 0),
	CONSTRAINT "chk_user_usage_rejected_nonnegative" CHECK ("user_usage_months"."rejected_count" >= 0),
	CONSTRAINT "chk_user_usage_egress_nonnegative" CHECK ("user_usage_months"."egress_bytes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "hosted_inbound_blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"block_type" varchar(32) NOT NULL,
	"value" varchar(320) NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_hosted_inbound_block_type" CHECK ("hosted_inbound_blocks"."block_type" in ('sender_email', 'sender_domain', 'recipient_domain', 'local_part'))
);
--> statement-breakpoint
CREATE TABLE "hosted_onboarding_attempts" (
	"bucket_type" varchar(32) NOT NULL,
	"bucket_key" varchar(255) NOT NULL,
	"window_start" varchar(10) NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hosted_onboarding_attempts_bucket_type_bucket_key_window_start_pk" PRIMARY KEY("bucket_type","bucket_key","window_start"),
	CONSTRAINT "chk_hosted_onboarding_attempts_nonnegative" CHECK ("hosted_onboarding_attempts"."attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "inbound_domains" ADD CONSTRAINT "inbound_domains_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allow_rules" ADD CONSTRAINT "allow_rules_email_address_id_email_addresses_id_fk" FOREIGN KEY ("email_address_id") REFERENCES "public"."email_addresses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_addresses" ADD CONSTRAINT "email_addresses_domain_id_inbound_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."inbound_domains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_addresses" ADD CONSTRAINT "email_addresses_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_attempts" ADD CONSTRAINT "delivery_attempts_delivery_log_id_delivery_logs_id_fk" FOREIGN KEY ("delivery_log_id") REFERENCES "public"."delivery_logs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_logs" ADD CONSTRAINT "delivery_logs_email_address_id_email_addresses_id_fk" FOREIGN KEY ("email_address_id") REFERENCES "public"."email_addresses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_logs" ADD CONSTRAINT "delivery_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_view_links" ADD CONSTRAINT "delivery_view_links_delivery_log_id_delivery_logs_id_fk" FOREIGN KEY ("delivery_log_id") REFERENCES "public"."delivery_logs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachment_links" ADD CONSTRAINT "attachment_links_attachment_id_attachments_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."attachments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_delivery_log_id_delivery_logs_id_fk" FOREIGN KEY ("delivery_log_id") REFERENCES "public"."delivery_logs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_storage_usage" ADD CONSTRAINT "user_storage_usage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manual_billing_events" ADD CONSTRAINT "manual_billing_events_telegram_user_id_users_id_fk" FOREIGN KEY ("telegram_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_usage_months" ADD CONSTRAINT "user_usage_months_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_user_stripe_customer" ON "users" USING btree ("stripe_customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_user_stripe_subscription" ON "users" USING btree ("stripe_subscription_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_inbound_domain_domain" ON "inbound_domains" USING btree ("domain");--> statement-breakpoint
CREATE INDEX "idx_inbound_domain_user_status" ON "inbound_domains" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "idx_allow_alias" ON "allow_rules" USING btree ("email_address_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_alias_local_part" ON "email_addresses" USING btree ("local_part") WHERE "email_addresses"."domain_id" is null;--> statement-breakpoint
CREATE INDEX "idx_alias_active" ON "email_addresses" USING btree ("local_part") WHERE status = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "idx_alias_domain_local_part" ON "email_addresses" USING btree ("domain_id","local_part") WHERE "email_addresses"."domain_id" is not null;--> statement-breakpoint
CREATE INDEX "idx_alias_chat" ON "email_addresses" USING btree ("chat_id");--> statement-breakpoint
CREATE INDEX "idx_alias_created_by" ON "email_addresses" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "idx_attempt_log" ON "delivery_attempts" USING btree ("delivery_log_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_attempt_log_no" ON "delivery_attempts" USING btree ("delivery_log_id","attempt_no");--> statement-breakpoint
CREATE INDEX "idx_log_user_time" ON "delivery_logs" USING btree ("user_id","received_at");--> statement-breakpoint
CREATE INDEX "idx_log_alias_time" ON "delivery_logs" USING btree ("email_address_id","received_at");--> statement-breakpoint
CREATE INDEX "idx_log_message_id" ON "delivery_logs" USING btree ("message_id_header");--> statement-breakpoint
CREATE INDEX "idx_log_body_hash" ON "delivery_logs" USING btree ("body_sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_log_dedup_msgid" ON "delivery_logs" USING btree ("email_address_id","message_id_header") WHERE message_id_header IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_log_dedup_bodyhash" ON "delivery_logs" USING btree ("email_address_id","body_sha256") WHERE body_sha256 IS NOT NULL AND body_dedup_applied = true;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_delivery_view_link_token_hash" ON "delivery_view_links" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_delivery_view_link_delivery_log" ON "delivery_view_links" USING btree ("delivery_log_id");--> statement-breakpoint
CREATE INDEX "idx_delivery_view_link_expires" ON "delivery_view_links" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_link_token" ON "attachment_links" USING btree ("token");--> statement-breakpoint
CREATE INDEX "idx_link_expires" ON "attachment_links" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_manual_billing_events_user_created" ON "manual_billing_events" USING btree ("telegram_user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_manual_billing_events_user_payment_ref" ON "manual_billing_events" USING btree ("telegram_user_id","payment_reference") WHERE payment_reference is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_manual_billing_events_payment_ref" ON "manual_billing_events" USING btree ("payment_reference") WHERE payment_reference is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_hosted_inbound_block_type_value" ON "hosted_inbound_blocks" USING btree ("block_type","value");