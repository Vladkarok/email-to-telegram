ALTER TABLE "organizations" ADD COLUMN "paid_through_at" timestamp with time zone;--> statement-breakpoint
UPDATE "organizations"
SET "paid_through_at" = "current_period_end"
WHERE "paid_through_at" IS NULL
  AND "current_period_end" IS NOT NULL
  AND "plan_code" <> 'free';
