CREATE TABLE "worker_request_nonces" (
	"signature_hash" varchar(64) PRIMARY KEY NOT NULL,
	"request_timestamp" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pgcrypto;--> statement-breakpoint
ALTER TABLE "attachment_links" ADD COLUMN "token_hash" varchar(64);--> statement-breakpoint
UPDATE "attachment_links" SET "token_hash" = encode(digest("token", 'sha256'), 'hex');--> statement-breakpoint
ALTER TABLE "attachment_links" ALTER COLUMN "token_hash" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_link_token_hash" ON "attachment_links" USING btree ("token_hash");
