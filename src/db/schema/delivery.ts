import {
  pgTable,
  bigint,
  varchar,
  boolean,
  timestamp,
  uuid,
  integer,
  smallint,
  text,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./users.js";
import { emailAddresses } from "./aliases.js";

// ─── delivery_logs ───────────────────────────────────────────────────────────

export const deliveryLogs = pgTable(
  "delivery_logs",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    emailAddressId: uuid("email_address_id")
      .notNull()
      .references(() => emailAddresses.id, { onDelete: "cascade" }),
    userId: bigint("user_id", { mode: "bigint" }).references(() => users.id),
    messageIdHeader: varchar("message_id_header", { length: 998 }),
    bodySha256: varchar("body_sha256", { length: 64 }),
    bodyDedupApplied: boolean("body_dedup_applied").notNull().default(false),
    envelopeFrom: varchar("envelope_from", { length: 320 }),
    headerFrom: varchar("header_from", { length: 320 }),
    subject: text("subject"),
    metadataCiphertext: text("metadata_ciphertext"),
    metadataEncryptionMode: varchar("metadata_encryption_mode", { length: 20 })
      .notNull()
      .default("none"),
    metadataWrappedDek: text("metadata_wrapped_dek"),
    metadataKekKeyId: varchar("metadata_kek_key_id", { length: 255 }),
    metadataEncryptedAt: timestamp("metadata_encrypted_at", { withTimezone: true }),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    // Set when the primary delivery path claims the log as "processing". Lets
    // the retry worker tell an in-progress delivery from one stranded by a
    // crashed process: a "processing" row is only retried once this is stale.
    processingStartedAt: timestamp("processing_started_at", { withTimezone: true }),
    rawSizeBytes: integer("raw_size_bytes"),
    rawEmailPath: varchar("raw_email_path", { length: 512 }),
    rawEmailEncryptionMode: varchar("raw_email_encryption_mode", { length: 20 })
      .notNull()
      .default("none"),
    rawEmailWrappedDek: text("raw_email_wrapped_dek"),
    rawEmailKekKeyId: varchar("raw_email_kek_key_id", { length: 255 }),
    rawEmailEncryptedAt: timestamp("raw_email_encrypted_at", { withTimezone: true }),
    hasAttachments: boolean("has_attachments").notNull().default(false),
    finalStatus: varchar("final_status", { length: 20 }).notNull().default("received"),
    billable: boolean("billable").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_log_user_time").on(t.userId, t.receivedAt),
    index("idx_log_alias_time").on(t.emailAddressId, t.receivedAt),
    index("idx_log_message_id").on(t.messageIdHeader),
    index("idx_log_body_hash").on(t.bodySha256),
    // Unique partial indexes enforce dedup at the DB level, closing the
    // SELECT-then-INSERT race when two requests arrive simultaneously.
    uniqueIndex("idx_log_dedup_msgid")
      .on(t.emailAddressId, t.messageIdHeader)
      .where(sql`message_id_header IS NOT NULL`),
    uniqueIndex("idx_log_dedup_bodyhash")
      .on(t.emailAddressId, t.bodySha256)
      .where(sql`body_sha256 IS NOT NULL AND body_dedup_applied = true`),
  ],
);

// ─── delivery_attempts ───────────────────────────────────────────────────────

export const deliveryAttempts = pgTable(
  "delivery_attempts",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    deliveryLogId: uuid("delivery_log_id")
      .notNull()
      .references(() => deliveryLogs.id, { onDelete: "cascade" }),
    attemptNo: smallint("attempt_no").notNull(),
    targetChatId: bigint("target_chat_id", { mode: "bigint" }).notNull(),
    targetThreadId: bigint("target_thread_id", { mode: "bigint" }),
    telegramMessageId: bigint("telegram_message_id", { mode: "bigint" }),
    status: varchar("status", { length: 20 }).notNull(),
    errorText: text("error_text"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_attempt_log").on(t.deliveryLogId),
    // One row per (log, attempt). Lets the post-send persistence retry be
    // idempotent: a re-run of the same transaction conflicts instead of
    // inserting a duplicate attempt row that would skew the retry budget.
    uniqueIndex("idx_attempt_log_no").on(t.deliveryLogId, t.attemptNo),
  ],
);

// ─── delivery_view_links ─────────────────────────────────────────────────────

export const deliveryViewLinks = pgTable(
  "delivery_view_links",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    deliveryLogId: uuid("delivery_log_id")
      .notNull()
      .references(() => deliveryLogs.id, { onDelete: "cascade" }),
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    viewedAt: timestamp("viewed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("idx_delivery_view_link_token_hash").on(t.tokenHash),
    uniqueIndex("idx_delivery_view_link_delivery_log").on(t.deliveryLogId),
    index("idx_delivery_view_link_expires").on(t.expiresAt),
  ],
);

// ─── Type exports ─────────────────────────────────────────────────────────────

export type DeliveryLog = typeof deliveryLogs.$inferSelect;
export type NewDeliveryLog = typeof deliveryLogs.$inferInsert;
export type DeliveryAttempt = typeof deliveryAttempts.$inferSelect;
export type NewDeliveryAttempt = typeof deliveryAttempts.$inferInsert;
export type DeliveryViewLink = typeof deliveryViewLinks.$inferSelect;
export type NewDeliveryViewLink = typeof deliveryViewLinks.$inferInsert;
