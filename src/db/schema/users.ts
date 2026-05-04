import { pgTable, bigint, varchar, boolean, timestamp } from "drizzle-orm/pg-core";

// ─── users ────────────────────────────────────────────────────────────────────

export const users = pgTable("users", {
  id: bigint("id", { mode: "bigint" }).primaryKey(),
  username: varchar("username", { length: 255 }),
  isAllowed: boolean("is_allowed").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
