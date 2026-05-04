import {
  pgTable,
  bigint,
  varchar,
  boolean,
  timestamp,
  uuid,
  index,
  uniqueIndex,
  primaryKey,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./users.js";

// ─── organizations ───────────────────────────────────────────────────────────

export const organizations = pgTable(
  "organizations",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    name: varchar("name", { length: 255 }).notNull(),
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
    uniqueIndex("idx_org_stripe_customer").on(t.stripeCustomerId),
    uniqueIndex("idx_org_stripe_subscription").on(t.stripeSubscriptionId),
    check(
      "chk_org_plan_code",
      sql`${t.planCode} in ('free', 'personal', 'pro', 'team', 'business')`,
    ),
    check(
      "chk_org_subscription_status",
      sql`${t.subscriptionStatus} in ('free', 'trialing', 'active', 'paused', 'past_due', 'canceled', 'unpaid', 'incomplete', 'incomplete_expired')`,
    ),
  ],
);

// ─── organization_members ────────────────────────────────────────────────────

export const organizationMembers = pgTable(
  "organization_members",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: bigint("user_id", { mode: "bigint" })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: varchar("role", { length: 20 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.userId] }),
    index("idx_org_member_user").on(t.userId),
    check("chk_org_member_role", sql`${t.role} in ('owner', 'admin', 'member')`),
  ],
);

// ─── inbound_domains ─────────────────────────────────────────────────────────

export const inboundDomains = pgTable(
  "inbound_domains",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    organizationId: uuid("organization_id").references(() => organizations.id, {
      onDelete: "cascade",
    }),
    domain: varchar("domain", { length: 255 }).notNull(),
    kind: varchar("kind", { length: 20 }).notNull(),
    status: varchar("status", { length: 20 }).notNull().default("active"),
    verificationToken: varchar("verification_token", { length: 255 }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("idx_inbound_domain_domain").on(t.domain),
    index("idx_inbound_domain_org_status").on(t.organizationId, t.status),
    check("chk_inbound_domain_kind", sql`${t.kind} in ('shared', 'custom')`),
    check("chk_inbound_domain_status", sql`${t.status} in ('active', 'pending', 'disabled')`),
    check(
      "chk_inbound_domain_ownership",
      sql`(${t.kind} = 'shared' and ${t.organizationId} is null) or (${t.kind} = 'custom' and ${t.organizationId} is not null)`,
    ),
  ],
);

// ─── chats ───────────────────────────────────────────────────────────────────

export const chats = pgTable("chats", {
  id: bigint("id", { mode: "bigint" }).primaryKey(),
  organizationId: uuid("organization_id").references(() => organizations.id),
  title: varchar("title", { length: 255 }).notNull(),
  type: varchar("type", { length: 20 }).notNull(), // 'private' | 'group' | 'supergroup' | 'channel'
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── Type exports ─────────────────────────────────────────────────────────────

export type Organization = typeof organizations.$inferSelect;
export type NewOrganization = typeof organizations.$inferInsert;
export type OrganizationMember = typeof organizationMembers.$inferSelect;
export type NewOrganizationMember = typeof organizationMembers.$inferInsert;
export type InboundDomain = typeof inboundDomains.$inferSelect;
export type NewInboundDomain = typeof inboundDomains.$inferInsert;
export type Chat = typeof chats.$inferSelect;
export type NewChat = typeof chats.$inferInsert;
