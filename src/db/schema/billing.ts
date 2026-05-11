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
import { organizations } from "./org.js";

// ─── organization_usage_months ───────────────────────────────────────────────

export const organizationUsageMonths = pgTable(
  "organization_usage_months",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
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
    primaryKey({ columns: [t.organizationId, t.month] }),
    check("chk_org_usage_month", sql`${t.month} ~ '^[0-9]{4}-[0-9]{2}$'`),
    check("chk_org_usage_delivered_nonnegative", sql`${t.deliveredCount} >= 0`),
    check("chk_org_usage_rejected_nonnegative", sql`${t.rejectedCount} >= 0`),
    check("chk_org_usage_egress_nonnegative", sql`${t.egressBytes} >= 0`),
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
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    telegramUserId: bigint("telegram_user_id", { mode: "bigint" }),
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
    index("idx_manual_billing_events_org_created").on(t.organizationId, t.createdAt),
    uniqueIndex("idx_manual_billing_events_org_payment_ref")
      .on(t.organizationId, t.paymentReference)
      .where(sql`payment_reference is not null`),
    uniqueIndex("idx_manual_billing_events_user_payment_ref")
      .on(t.telegramUserId, t.paymentReference)
      .where(sql`telegram_user_id is not null and payment_reference is not null`),
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

// ─── Type exports ─────────────────────────────────────────────────────────────

export type OrganizationUsageMonth = typeof organizationUsageMonths.$inferSelect;
export type NewOrganizationUsageMonth = typeof organizationUsageMonths.$inferInsert;
export type BillingWebhookEvent = typeof billingWebhookEvents.$inferSelect;
export type NewBillingWebhookEvent = typeof billingWebhookEvents.$inferInsert;
export type ManualBillingEvent = typeof manualBillingEvents.$inferSelect;
export type NewManualBillingEvent = typeof manualBillingEvents.$inferInsert;
