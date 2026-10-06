import {
  pgTable,
  bigint,
  varchar,
  timestamp,
  uuid,
  integer,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { emailAddresses } from "./aliases.js";

// ─── alias_activation ────────────────────────────────────────────────────────
// One row per alias, written by two independent paths:
//
// - Delivery writes `first_delivered_at` once, after the first Telegram text
//   message of any delivery to the alias succeeded. An alias with that marker
//   (or with any surviving succeeded delivery attempt) is "working".
// - The bounce notice for a not-yet-working alias claims the row: the claim
//   spends one of a small lifetime budget (`claims_used`), stamps
//   `last_claim_at` for the rolling 24 h window, and issues a fresh one-tap
//   token that expires with `expires_at`. `domain` is the only piece of
//   sender data stored: the header From domain of the latest claim, set only
//   when that domain authenticated the message. The cleanup loop nulls
//   `token` and `domain` once `expires_at` passes.
//
// `chat_id` and `routing_version` snapshot the alias at claim time; the
// one-tap button only works while the alias still matches them. The alias
// row itself is never written by this feature. Deleting the alias deletes
// this row (FK cascade), which is also how /delete_me reaches it.

export const aliasActivation = pgTable(
  "alias_activation",
  {
    aliasId: uuid("alias_id")
      .primaryKey()
      .references(() => emailAddresses.id, { onDelete: "cascade" }),
    firstDeliveredAt: timestamp("first_delivered_at", { withTimezone: true }),
    claimsUsed: integer("claims_used").notNull().default(0),
    lastClaimAt: timestamp("last_claim_at", { withTimezone: true }),
    firstNoticeAt: timestamp("first_notice_at", { withTimezone: true }),
    token: varchar("token", { length: 22 }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    domain: varchar("domain", { length: 253 }),
    chatId: bigint("chat_id", { mode: "bigint" }),
    routingVersion: integer("routing_version"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    firstSentAt: timestamp("first_sent_at", { withTimezone: true }),
  },
  (t) => [
    // The cleanup pass only visits rows that still hold a token or a domain.
    index("idx_alias_activation_expiry")
      .on(t.expiresAt)
      .where(sql`token IS NOT NULL OR domain IS NOT NULL`),
    check("chk_alias_activation_claims_nonnegative", sql`${t.claimsUsed} >= 0`),
  ],
);

export type AliasActivation = typeof aliasActivation.$inferSelect;
export type NewAliasActivation = typeof aliasActivation.$inferInsert;
