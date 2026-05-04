import { pgTable, varchar, timestamp, uuid, integer, text, uniqueIndex, primaryKey, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ─── hosted_onboarding_attempts ──────────────────────────────────────────────

export const hostedOnboardingAttempts = pgTable(
  "hosted_onboarding_attempts",
  {
    bucketType: varchar("bucket_type", { length: 32 }).notNull(),
    bucketKey: varchar("bucket_key", { length: 255 }).notNull(),
    windowStart: varchar("window_start", { length: 10 }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.bucketType, t.bucketKey, t.windowStart] }),
    check("chk_hosted_onboarding_attempts_nonnegative", sql`${t.attempts} >= 0`),
  ],
);

// ─── hosted_inbound_blocks ───────────────────────────────────────────────────

export const hostedInboundBlocks = pgTable(
  "hosted_inbound_blocks",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    blockType: varchar("block_type", { length: 32 }).notNull(),
    value: varchar("value", { length: 320 }).notNull(),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("idx_hosted_inbound_block_type_value").on(t.blockType, t.value),
    check(
      "chk_hosted_inbound_block_type",
      sql`${t.blockType} in ('sender_email', 'sender_domain', 'recipient_domain', 'local_part')`,
    ),
  ],
);

// ─── Type exports ─────────────────────────────────────────────────────────────

export type HostedOnboardingAttempt = typeof hostedOnboardingAttempts.$inferSelect;
export type NewHostedOnboardingAttempt = typeof hostedOnboardingAttempts.$inferInsert;
export type HostedInboundBlock = typeof hostedInboundBlocks.$inferSelect;
export type NewHostedInboundBlock = typeof hostedInboundBlocks.$inferInsert;
