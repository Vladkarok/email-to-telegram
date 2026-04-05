CREATE TABLE "allow_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email_address_id" uuid NOT NULL,
	"match_type" varchar(20) NOT NULL,
	"match_value" varchar(320) NOT NULL,
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
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
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
	"message_id_header" varchar(998),
	"body_sha256" varchar(64),
	"envelope_from" varchar(320),
	"header_from" varchar(320),
	"subject" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"raw_size_bytes" integer,
	"raw_email_path" varchar(512),
	"has_attachments" boolean DEFAULT false NOT NULL,
	"final_status" varchar(20) DEFAULT 'received' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_addresses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"local_part" varchar(64) NOT NULL,
	"full_address" varchar(320) NOT NULL,
	"chat_id" bigint NOT NULL,
	"message_thread_id" bigint,
	"created_by" bigint NOT NULL,
	"render_mode" varchar(20) DEFAULT 'plaintext' NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"max_emails_hour" integer DEFAULT 60 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" bigint PRIMARY KEY NOT NULL,
	"username" varchar(255),
	"is_allowed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "allow_rules" ADD CONSTRAINT "allow_rules_email_address_id_email_addresses_id_fk" FOREIGN KEY ("email_address_id") REFERENCES "public"."email_addresses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachment_links" ADD CONSTRAINT "attachment_links_attachment_id_attachments_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."attachments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_delivery_log_id_delivery_logs_id_fk" FOREIGN KEY ("delivery_log_id") REFERENCES "public"."delivery_logs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_attempts" ADD CONSTRAINT "delivery_attempts_delivery_log_id_delivery_logs_id_fk" FOREIGN KEY ("delivery_log_id") REFERENCES "public"."delivery_logs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_logs" ADD CONSTRAINT "delivery_logs_email_address_id_email_addresses_id_fk" FOREIGN KEY ("email_address_id") REFERENCES "public"."email_addresses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_addresses" ADD CONSTRAINT "email_addresses_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_allow_alias" ON "allow_rules" USING btree ("email_address_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_link_token" ON "attachment_links" USING btree ("token");--> statement-breakpoint
CREATE INDEX "idx_link_expires" ON "attachment_links" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_attempt_log" ON "delivery_attempts" USING btree ("delivery_log_id");--> statement-breakpoint
CREATE INDEX "idx_log_alias_time" ON "delivery_logs" USING btree ("email_address_id","received_at");--> statement-breakpoint
CREATE INDEX "idx_log_message_id" ON "delivery_logs" USING btree ("message_id_header");--> statement-breakpoint
CREATE INDEX "idx_log_body_hash" ON "delivery_logs" USING btree ("body_sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_alias_local_part" ON "email_addresses" USING btree ("local_part");--> statement-breakpoint
CREATE INDEX "idx_alias_active" ON "email_addresses" USING btree ("local_part") WHERE status = 'active';--> statement-breakpoint
CREATE INDEX "idx_alias_chat" ON "email_addresses" USING btree ("chat_id");