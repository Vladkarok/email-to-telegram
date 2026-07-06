import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { lt } from "drizzle-orm";
import { userQuotaNotifications } from "../schema.js";
import type * as schema from "../schema.js";

type Db = NodePgDatabase<typeof schema>;

export type QuotaNotificationReason =
  | "monthly_email_limit"
  | "storage_limit"
  | "subscription_inactive";

/**
 * Claims the single notification slot for (user, reason, month). The PK insert
 * is the claim: exactly one concurrent caller wins, everyone else gets false.
 * A mail flood at quota therefore produces exactly one Telegram notice.
 */
export async function claimQuotaNotification(
  db: Db,
  userId: bigint,
  reason: QuotaNotificationReason,
  month: string,
): Promise<boolean> {
  const rows = await db
    .insert(userQuotaNotifications)
    .values({ userId, reason, month })
    .onConflictDoNothing()
    .returning();
  return rows.length > 0;
}

/** Purges claim rows older than `cutoff`. Returns the number of purged rows. */
export async function deleteOldQuotaNotifications(db: Db, cutoff: Date): Promise<number> {
  const result = await db
    .delete(userQuotaNotifications)
    .where(lt(userQuotaNotifications.sentAt, cutoff));
  return (result as unknown as { rowCount?: number }).rowCount ?? 0;
}
