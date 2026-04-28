CREATE TABLE "hosted_onboarding_attempts" (
	"bucket_type" varchar(32) NOT NULL,
	"bucket_key" varchar(255) NOT NULL,
	"window_start" varchar(10) NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hosted_onboarding_attempts_bucket_type_bucket_key_window_start_pk" PRIMARY KEY("bucket_type","bucket_key","window_start"),
	CONSTRAINT "chk_hosted_onboarding_attempts_nonnegative" CHECK ("hosted_onboarding_attempts"."attempts" >= 0)
);
