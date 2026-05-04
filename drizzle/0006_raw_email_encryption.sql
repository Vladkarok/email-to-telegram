ALTER TABLE "delivery_logs" ADD COLUMN "raw_email_encryption_mode" varchar(20) DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "delivery_logs" ADD COLUMN "raw_email_wrapped_dek" text;--> statement-breakpoint
ALTER TABLE "delivery_logs" ADD COLUMN "raw_email_kek_key_id" varchar(255);--> statement-breakpoint
ALTER TABLE "delivery_logs" ADD COLUMN "raw_email_encrypted_at" timestamp with time zone;