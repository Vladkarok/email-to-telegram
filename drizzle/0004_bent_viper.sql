CREATE TABLE "delivery_view_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"delivery_log_id" uuid NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"viewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "email_addresses" ADD COLUMN "privacy_mode_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "delivery_view_links" ADD CONSTRAINT "delivery_view_links_delivery_log_id_delivery_logs_id_fk" FOREIGN KEY ("delivery_log_id") REFERENCES "public"."delivery_logs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_delivery_view_link_token_hash" ON "delivery_view_links" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "idx_delivery_view_link_expires" ON "delivery_view_links" USING btree ("expires_at");
