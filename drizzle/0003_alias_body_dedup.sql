DROP INDEX "idx_log_dedup_bodyhash";--> statement-breakpoint
ALTER TABLE "delivery_logs" ADD COLUMN "body_dedup_applied" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "email_addresses" ADD COLUMN "body_dedup_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "email_addresses" SET "body_dedup_enabled" = true;--> statement-breakpoint
UPDATE "delivery_logs" SET "body_dedup_applied" = true WHERE "body_sha256" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_log_dedup_bodyhash" ON "delivery_logs" USING btree ("email_address_id","body_sha256") WHERE body_sha256 IS NOT NULL AND body_dedup_applied = true;
