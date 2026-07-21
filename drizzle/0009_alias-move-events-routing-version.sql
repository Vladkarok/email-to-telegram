CREATE TABLE "alias_move_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operation_id" uuid NOT NULL,
	"alias_id" uuid NOT NULL,
	"alias_owner_id" bigint NOT NULL,
	"actor_id" bigint,
	"authz_path" varchar(20) NOT NULL,
	"old_chat_id" bigint NOT NULL,
	"new_chat_id" bigint NOT NULL,
	"old_thread_id" bigint,
	"new_thread_id" bigint,
	"outcome" varchar(20) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_alias_move_events_authz_path" CHECK ("alias_move_events"."authz_path" in ('admin', 'orphan', 'migration')),
	CONSTRAINT "chk_alias_move_events_outcome" CHECK ("alias_move_events"."outcome" in ('succeeded', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "email_addresses" ADD COLUMN "routing_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_alias_move_events_alias_time" ON "alias_move_events" USING btree ("alias_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_alias_move_events_owner" ON "alias_move_events" USING btree ("alias_owner_id");