import { timestamp, varchar, pgTable } from "drizzle-orm/pg-core";

export const workerRequestNonces = pgTable("worker_request_nonces", {
  signatureHash: varchar("signature_hash", { length: 64 }).primaryKey(),
  requestTimestamp: timestamp("request_timestamp", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
