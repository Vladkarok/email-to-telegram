CREATE TABLE "hosted_inbound_blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"block_type" varchar(32) NOT NULL,
	"value" varchar(320) NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_hosted_inbound_block_type" CHECK ("hosted_inbound_blocks"."block_type" in ('sender_email', 'sender_domain', 'recipient_domain', 'local_part'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_hosted_inbound_block_type_value" ON "hosted_inbound_blocks" USING btree ("block_type","value");
