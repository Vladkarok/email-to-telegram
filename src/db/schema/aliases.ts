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
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations, inboundDomains } from "./org.js";
import { users } from "./users.js";

// ─── email_addresses ─────────────────────────────────────────────────────────

export const emailAddresses = pgTable(
  "email_addresses",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    localPart: varchar("local_part", { length: 64 }).notNull(),
    fullAddress: varchar("full_address", { length: 320 }).notNull(),
    organizationId: uuid("organization_id").references(() => organizations.id),
    domainId: uuid("domain_id").references(() => inboundDomains.id),
    chatId: bigint("chat_id", { mode: "bigint" }).notNull(),
    messageThreadId: bigint("message_thread_id", { mode: "bigint" }),
    createdBy: bigint("created_by", { mode: "bigint" })
      .notNull()
      .references(() => users.id),
    renderMode: varchar("render_mode", { length: 20 }).notNull().default("plaintext"),
    privacyModeEnabled: boolean("privacy_mode_enabled").notNull().default(false),
    bodyDedupEnabled: boolean("body_dedup_enabled").notNull().default(false),
    status: varchar("status", { length: 20 }).notNull().default("active"),
    maxEmailsHour: integer("max_emails_hour").notNull().default(60),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("idx_alias_local_part")
      .on(t.localPart)
      .where(sql`${t.domainId} is null`),
    index("idx_alias_active")
      .on(t.localPart)
      .where(sql`status = 'active'`),
    index("idx_alias_org").on(t.organizationId),
    uniqueIndex("idx_alias_domain_local_part")
      .on(t.domainId, t.localPart)
      .where(sql`${t.domainId} is not null`),
    index("idx_alias_chat").on(t.chatId),
  ],
);

// ─── allow_rules ─────────────────────────────────────────────────────────────

export const allowRules = pgTable(
  "allow_rules",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    emailAddressId: uuid("email_address_id")
      .notNull()
      .references(() => emailAddresses.id, { onDelete: "cascade" }),
    matchType: varchar("match_type", { length: 20 }).notNull(),
    matchValue: varchar("match_value", { length: 320 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_allow_alias").on(t.emailAddressId)],
);

// ─── Type exports ─────────────────────────────────────────────────────────────

export type EmailAddress = typeof emailAddresses.$inferSelect;
export type NewEmailAddress = typeof emailAddresses.$inferInsert;
export type AllowRule = typeof allowRules.$inferSelect;
export type NewAllowRule = typeof allowRules.$inferInsert;
