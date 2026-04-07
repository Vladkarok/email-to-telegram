ALTER TABLE "delivery_logs" ADD COLUMN "metadata_ciphertext" text;--> statement-breakpoint
ALTER TABLE "delivery_logs" ADD COLUMN "metadata_encryption_mode" varchar(20) DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "delivery_logs" ADD COLUMN "metadata_wrapped_dek" text;--> statement-breakpoint
ALTER TABLE "delivery_logs" ADD COLUMN "metadata_kek_key_id" varchar(255);--> statement-breakpoint
ALTER TABLE "delivery_logs" ADD COLUMN "metadata_encrypted_at" timestamp with time zone;