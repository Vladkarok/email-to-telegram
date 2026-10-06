CREATE TABLE "alias_activation" (
	"alias_id" uuid PRIMARY KEY NOT NULL,
	"first_delivered_at" timestamp with time zone,
	"claims_used" integer DEFAULT 0 NOT NULL,
	"last_claim_at" timestamp with time zone,
	"first_notice_at" timestamp with time zone,
	"token" varchar(22),
	"expires_at" timestamp with time zone,
	"domain" varchar(253),
	"chat_id" bigint,
	"routing_version" integer,
	"sent_at" timestamp with time zone,
	"first_sent_at" timestamp with time zone,
	CONSTRAINT "chk_alias_activation_claims_nonnegative" CHECK ("alias_activation"."claims_used" >= 0)
);
--> statement-breakpoint
ALTER TABLE "alias_activation" ADD CONSTRAINT "alias_activation_alias_id_email_addresses_id_fk" FOREIGN KEY ("alias_id") REFERENCES "public"."email_addresses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_alias_activation_expiry" ON "alias_activation" USING btree ("expires_at") WHERE token IS NOT NULL OR domain IS NOT NULL;--> statement-breakpoint
-- Backfill: every alias with a surviving succeeded delivery attempt is
-- already working. Older history purged by retention cannot be recovered.
INSERT INTO "alias_activation" ("alias_id", "first_delivered_at")
SELECT dl."email_address_id", min(da."created_at")
FROM "delivery_attempts" da
JOIN "delivery_logs" dl ON dl."id" = da."delivery_log_id"
WHERE da."status" = 'succeeded'
GROUP BY dl."email_address_id"
ON CONFLICT ("alias_id") DO NOTHING;