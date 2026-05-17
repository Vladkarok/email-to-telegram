import {
  pgTable,
  bigint,
  varchar,
  boolean,
  timestamp,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ─── users ────────────────────────────────────────────────────────────────────
// A user IS the tenant. Billing, plan, quotas, and custom inbound domains all
// hang off this row directly — there is no separate "organization".

export const users = pgTable(
  "users",
  {
    id: bigint("id", { mode: "bigint" }).primaryKey(),
    username: varchar("username", { length: 255 }),
    locale: varchar("locale", { length: 16 }),
    isAllowed: boolean("is_allowed").notNull().default(false),
    planCode: varchar("plan_code", { length: 32 }).notNull().default("free"),
    subscriptionStatus: varchar("subscription_status", { length: 32 }).notNull().default("free"),
    stripeCustomerId: varchar("stripe_customer_id", { length: 255 }),
    stripeSubscriptionId: varchar("stripe_subscription_id", { length: 255 }),
    trialEndsAt: timestamp("trial_ends_at", { withTimezone: true }),
    currentPeriodStart: timestamp("current_period_start", { withTimezone: true }),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    paidThroughAt: timestamp("paid_through_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("idx_user_stripe_customer").on(t.stripeCustomerId),
    uniqueIndex("idx_user_stripe_subscription").on(t.stripeSubscriptionId),
    check(
      "chk_user_plan_code",
      sql`${t.planCode} in ('free', 'personal', 'pro', 'team', 'business')`,
    ),
    check(
      "chk_user_subscription_status",
      sql`${t.subscriptionStatus} in ('free', 'trialing', 'active', 'paused', 'past_due', 'canceled', 'unpaid', 'incomplete', 'incomplete_expired')`,
    ),
  ],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
