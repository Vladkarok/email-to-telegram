ALTER TABLE "attachments" ADD COLUMN "encryption_mode" varchar(20) DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "wrapped_dek" text;--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "kek_key_id" varchar(255);--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "encrypted_at" timestamp with time zone;