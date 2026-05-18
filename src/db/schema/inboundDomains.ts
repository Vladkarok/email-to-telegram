import {
  pgTable,
  bigint,
  varchar,
  timestamp,
  uuid,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./users.js";

// Shared domains: user_id NULL. Custom domains: owned by exactly one user.

export const inboundDomains = pgTable(
  "inbound_domains",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: bigint("user_id", { mode: "bigint" }).references(() => users.id, {
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
    index("idx_inbound_domain_user_status").on(t.userId, t.status),
    check("chk_inbound_domain_kind", sql`${t.kind} in ('shared', 'custom')`),
    check("chk_inbound_domain_status", sql`${t.status} in ('active', 'pending', 'disabled')`),
    check(
      "chk_inbound_domain_ownership",
      sql`(${t.kind} = 'shared' and ${t.userId} is null) or (${t.kind} = 'custom' and ${t.userId} is not null)`,
    ),
  ],
);

export type InboundDomain = typeof inboundDomains.$inferSelect;
export type NewInboundDomain = typeof inboundDomains.$inferInsert;
