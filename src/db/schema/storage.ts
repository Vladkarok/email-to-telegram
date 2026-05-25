import {
  pgTable,
  bigint,
  varchar,
  timestamp,
  uuid,
  integer,
  text,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./users.js";
import { deliveryLogs } from "./delivery.js";

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
  encryptionMode: varchar("encryption_mode", { length: 20 }).notNull().default("none"),
  wrappedDek: text("wrapped_dek"),
  kekKeyId: varchar("kek_key_id", { length: 255 }),
  encryptedAt: timestamp("encrypted_at", { withTimezone: true }),
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
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    downloadedAt: timestamp("downloaded_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("idx_link_token").on(t.token),
    uniqueIndex("idx_link_token_hash").on(t.tokenHash),
    index("idx_link_expires").on(t.expiresAt),
  ],
);

// ─── user_storage_usage ──────────────────────────────────────────────────────

export const userStorageUsage = pgTable(
  "user_storage_usage",
  {
    userId: bigint("user_id", { mode: "bigint" })
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    rawEmailBytes: bigint("raw_email_bytes", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    attachmentBytes: bigint("attachment_bytes", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("chk_user_storage_raw_nonnegative", sql`${t.rawEmailBytes} >= 0`),
    check("chk_user_storage_attachment_nonnegative", sql`${t.attachmentBytes} >= 0`),
  ],
);

// ─── Type exports ─────────────────────────────────────────────────────────────

export type Attachment = typeof attachments.$inferSelect;
export type NewAttachment = typeof attachments.$inferInsert;
export type AttachmentLink = typeof attachmentLinks.$inferSelect;
export type NewAttachmentLink = typeof attachmentLinks.$inferInsert;
export type UserStorageUsage = typeof userStorageUsage.$inferSelect;
export type NewUserStorageUsage = typeof userStorageUsage.$inferInsert;
