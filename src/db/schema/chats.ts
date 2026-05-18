import { pgTable, bigint, varchar, boolean, timestamp } from "drizzle-orm/pg-core";

// Aliases attach directly to chats. Telegram chat membership enforces who can
// see forwarded mail; no app-side membership table is needed.

export const chats = pgTable("chats", {
  id: bigint("id", { mode: "bigint" }).primaryKey(),
  title: varchar("title", { length: 255 }).notNull(),
  type: varchar("type", { length: 20 }).notNull(), // 'private' | 'group' | 'supergroup' | 'channel'
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Chat = typeof chats.$inferSelect;
export type NewChat = typeof chats.$inferInsert;
