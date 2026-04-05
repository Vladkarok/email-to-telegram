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

// ─── users ────────────────────────────────────────────────────────────────────

export const users = pgTable("users", {
  id: bigint("id", { mode: "bigint" }).primaryKey(),
  username: varchar("username", { length: 255 }),
  isAllowed: boolean("is_allowed").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── email_addresses ─────────────────────────────────────────────────────────

export const emailAddresses = pgTable(
  "email_addresses",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    localPart: varchar("local_part", { length: 64 }).notNull(),
    fullAddress: varchar("full_address", { length: 320 }).notNull(),
    chatId: bigint("chat_id", { mode: "bigint" }).notNull(),
    messageThreadId: bigint("message_thread_id", { mode: "bigint" }),
    createdBy: bigint("created_by", { mode: "bigint" })
      .notNull()
      .references(() => users.id),
    renderMode: varchar("render_mode", { length: 20 }).notNull().default("plaintext"),
    status: varchar("status", { length: 20 }).notNull().default("active"),
    maxEmailsHour: integer("max_emails_hour").notNull().default(60),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("idx_alias_local_part").on(t.localPart),
    index("idx_alias_active")
      .on(t.localPart)
      .where(sql`status = 'active'`),
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
    messageIdHeader: varchar("message_id_header", { length: 998 }),
    bodySha256: varchar("body_sha256", { length: 64 }),
    envelopeFrom: varchar("envelope_from", { length: 320 }),
    headerFrom: varchar("header_from", { length: 320 }),
    subject: text("subject"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    rawSizeBytes: integer("raw_size_bytes"),
    rawEmailPath: varchar("raw_email_path", { length: 512 }),
    hasAttachments: boolean("has_attachments").notNull().default(false),
    finalStatus: varchar("final_status", { length: 20 }).notNull().default("received"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_log_alias_time").on(t.emailAddressId, t.receivedAt),
    index("idx_log_message_id").on(t.messageIdHeader),
    index("idx_log_body_hash").on(t.bodySha256),
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
  (t) => [index("idx_attempt_log").on(t.deliveryLogId)],
);

// ─── attachments ─────────────────────────────────────────────────────────────

export const attachments = pgTable("attachments", {
  id: uuid("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  deliveryLogId: uuid("delivery_log_id")
    .notNull()
    .references(() => deliveryLogs.id, { onDelete: "cascade" }),
  originalFilename: varchar("original_filename", { length: 255 }),
  contentType: varchar("content_type", { length: 127 }),
  sizeBytes: integer("size_bytes"),
  sha256: varchar("sha256", { length: 64 }),
  storagePath: varchar("storage_path", { length: 512 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── attachment_links ────────────────────────────────────────────────────────

export const attachmentLinks = pgTable(
  "attachment_links",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    attachmentId: uuid("attachment_id")
      .notNull()
      .references(() => attachments.id, { onDelete: "cascade" }),
    token: varchar("token", { length: 96 }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    downloadedAt: timestamp("downloaded_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("idx_link_token").on(t.token), index("idx_link_expires").on(t.expiresAt)],
);

// ─── Type exports ─────────────────────────────────────────────────────────────

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type EmailAddress = typeof emailAddresses.$inferSelect;
export type NewEmailAddress = typeof emailAddresses.$inferInsert;
export type AllowRule = typeof allowRules.$inferSelect;
export type NewAllowRule = typeof allowRules.$inferInsert;
export type DeliveryLog = typeof deliveryLogs.$inferSelect;
export type NewDeliveryLog = typeof deliveryLogs.$inferInsert;
export type DeliveryAttempt = typeof deliveryAttempts.$inferSelect;
export type NewDeliveryAttempt = typeof deliveryAttempts.$inferInsert;
export type Attachment = typeof attachments.$inferSelect;
export type NewAttachment = typeof attachments.$inferInsert;
export type AttachmentLink = typeof attachmentLinks.$inferSelect;
export type NewAttachmentLink = typeof attachmentLinks.$inferInsert;
