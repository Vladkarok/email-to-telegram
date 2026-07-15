import {
  pgTable,
  bigint,
  varchar,
  boolean,
  timestamp,
  uuid,
  integer,
  index,
  uniqueIndex,
  primaryKey,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./users.js";

// ─── user_usage_months ───────────────────────────────────────────────────────

export const userUsageMonths = pgTable(
  "user_usage_months",
  {
    userId: bigint("user_id", { mode: "bigint" })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    month: varchar("month", { length: 7 }).notNull(),
    deliveredCount: integer("delivered_count").notNull().default(0),
    rejectedCount: integer("rejected_count").notNull().default(0),
    egressBytes: bigint("egress_bytes", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.month] }),
    check("chk_user_usage_month", sql`${t.month} ~ '^[0-9]{4}-[0-9]{2}$'`),
    check("chk_user_usage_delivered_nonnegative", sql`${t.deliveredCount} >= 0`),
    check("chk_user_usage_rejected_nonnegative", sql`${t.rejectedCount} >= 0`),
    check("chk_user_usage_egress_nonnegative", sql`${t.egressBytes} >= 0`),
  ],
);

// ─── billing_webhook_events ──────────────────────────────────────────────────

export const billingWebhookEvents = pgTable("billing_webhook_events", {
  eventId: varchar("event_id", { length: 255 }).primaryKey(),
  eventType: varchar("event_type", { length: 255 }).notNull(),
  processedAt: timestamp("processed_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── manual_billing_events ───────────────────────────────────────────────────

export const manualBillingEvents = pgTable(
  "manual_billing_events",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    telegramUserId: bigint("telegram_user_id", { mode: "bigint" })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    planCode: varchar("plan_code", { length: 32 }).notNull(),
    subscriptionStatus: varchar("subscription_status", { length: 32 }).notNull(),
    paidThroughAt: timestamp("paid_through_at", { withTimezone: true }),
    paymentReference: varchar("payment_reference", { length: 255 }),
    note: varchar("note", { length: 1000 }),
    keptStripeLink: boolean("kept_stripe_link").notNull().default(false),
    operatorSource: varchar("operator_source", { length: 64 }).notNull().default("cli"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_manual_billing_events_user_created").on(t.telegramUserId, t.createdAt),
    uniqueIndex("idx_manual_billing_events_user_payment_ref")
      .on(t.telegramUserId, t.paymentReference)
      .where(sql`payment_reference is not null`),
    uniqueIndex("idx_manual_billing_events_payment_ref")
      .on(t.paymentReference)
      .where(sql`payment_reference is not null`),
    check(
      "chk_manual_billing_events_plan_code",
      sql`${t.planCode} in ('free', 'personal', 'pro', 'team', 'business')`,
    ),
    check(
      "chk_manual_billing_events_subscription_status",
      sql`${t.subscriptionStatus} in ('free', 'active', 'canceled')`,
    ),
  ],
);

// ─── user_quota_notifications ────────────────────────────────────────────────
// Claim ledger for quota Telegram notices: at most one notification per user,
// per reason, per claim period. The PK is the claim — INSERT ... ON CONFLICT
// DO NOTHING decides which pipeline invocation sends. The period is a month
// ("2026-07") for exhaustion/approaching notices, or an ISO week ("2026-W29")
// for the while-capped reminder.

export const userQuotaNotifications = pgTable(
  "user_quota_notifications",
  {
    userId: bigint("user_id", { mode: "bigint" })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    reason: varchar("reason", { length: 32 }).notNull(),
    month: varchar("month", { length: 8 }).notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.reason, t.month] }),
    check(
      "chk_user_quota_notifications_month",
      sql`${t.month} ~ '^[0-9]{4}-([0-9]{2}|W[0-9]{2})$'`,
    ),
    check(
      "chk_user_quota_notifications_reason",
      sql`${t.reason} in ('monthly_email_limit', 'storage_limit', 'subscription_inactive', 'approaching_monthly_limit', 'monthly_email_limit_reminder')`,
    ),
  ],
);

// ─── Type exports ─────────────────────────────────────────────────────────────

export type UserQuotaNotification = typeof userQuotaNotifications.$inferSelect;
export type NewUserQuotaNotification = typeof userQuotaNotifications.$inferInsert;
export type UserUsageMonth = typeof userUsageMonths.$inferSelect;
export type NewUserUsageMonth = typeof userUsageMonths.$inferInsert;
export type BillingWebhookEvent = typeof billingWebhookEvents.$inferSelect;
export type NewBillingWebhookEvent = typeof billingWebhookEvents.$inferInsert;
export type ManualBillingEvent = typeof manualBillingEvents.$inferSelect;
export type NewManualBillingEvent = typeof manualBillingEvents.$inferInsert;
