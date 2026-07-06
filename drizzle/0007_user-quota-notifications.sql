CREATE TABLE "user_quota_notifications" (
	"user_id" bigint NOT NULL,
	"reason" varchar(32) NOT NULL,
	"month" varchar(7) NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_quota_notifications_user_id_reason_month_pk" PRIMARY KEY("user_id","reason","month"),
	CONSTRAINT "chk_user_quota_notifications_month" CHECK ("user_quota_notifications"."month" ~ '^[0-9]{4}-[0-9]{2}$'),
	CONSTRAINT "chk_user_quota_notifications_reason" CHECK ("user_quota_notifications"."reason" in ('monthly_email_limit', 'storage_limit', 'subscription_inactive'))
);
--> statement-breakpoint
ALTER TABLE "user_quota_notifications" ADD CONSTRAINT "user_quota_notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;