import { pgTable, bigint, varchar, timestamp, uuid, index, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ─── alias_move_events ───────────────────────────────────────────────────────
// Append-only audit of every routing change an alias undergoes: deliberate
// moves, orphan recoveries, and chat-id migrations.
//
// Deliberately WITHOUT foreign keys. The audit must survive the hard deletion
// of the alias row by the tombstone purge, and ownership must stay traceable
// after that row is gone — so both `alias_id` and `alias_owner_id` are
// denormalized copies, not references. GDPR erasure deletes by
// `alias_owner_id` and anonymizes `actor_id` explicitly (see deleteUser).
//
// The audit insert and its routing mutation commit in ONE transaction: a move
// without its audit row cannot exist. A migration writes one row per affected
// alias, all sharing a single `operation_id`, with `actor_id` null.

export const aliasMoveEvents = pgTable(
  "alias_move_events",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    /** Groups the per-alias rows written by one migration or move operation. */
    operationId: uuid("operation_id").notNull(),
    aliasId: uuid("alias_id").notNull(),
    /** Denormalized alias owner; the key GDPR erasure and export select on. */
    aliasOwnerId: bigint("alias_owner_id", { mode: "bigint" }).notNull(),
    /** Null for migrations (no human actor) and after GDPR anonymisation. */
    actorId: bigint("actor_id", { mode: "bigint" }),
    authzPath: varchar("authz_path", { length: 20 }).notNull(),
    oldChatId: bigint("old_chat_id", { mode: "bigint" }).notNull(),
    newChatId: bigint("new_chat_id", { mode: "bigint" }).notNull(),
    // Thread ids are forensics only: a compensating move clears the thread
    // like any other move, so these are never replayed as state.
    oldThreadId: bigint("old_thread_id", { mode: "bigint" }),
    newThreadId: bigint("new_thread_id", { mode: "bigint" }),
    outcome: varchar("outcome", { length: 20 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_alias_move_events_alias_time").on(t.aliasId, t.createdAt),
    index("idx_alias_move_events_owner").on(t.aliasOwnerId),
    check(
      "chk_alias_move_events_authz_path",
      sql`${t.authzPath} in ('admin', 'orphan', 'migration')`,
    ),
    check("chk_alias_move_events_outcome", sql`${t.outcome} in ('succeeded', 'failed')`),
  ],
);

export type AliasMoveEvent = typeof aliasMoveEvents.$inferSelect;
export type NewAliasMoveEvent = typeof aliasMoveEvents.$inferInsert;
