import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { lt } from "drizzle-orm";
import { userQuotaNotifications } from "../schema.js";
import type * as schema from "../schema.js";

type Db = NodePgDatabase<typeof schema>;

export type QuotaNotificationReason =
  | "monthly_email_limit"
  | "storage_limit"
  | "subscription_inactive";

export type QuotaNoticeReason =
  | QuotaNotificationReason
  | "approaching_monthly_limit"
  | "monthly_email_limit_reminder";

/**
 * ISO-8601 week key ("2026-W29", UTC) — the claim period for while-capped
 * reminder notices, alongside the "YYYY-MM" month key used by the others.
 */
export function quotaWeekForDate(date = new Date()): string {
  const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const weekday = day.getUTCDay() || 7; // Mon=1 … Sun=7
  day.setUTCDate(day.getUTCDate() + 4 - weekday); // shift to this week's Thursday
  const yearStart = Date.UTC(day.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((day.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${day.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/**
 * Claims the single notification slot for (user, reason, period). The PK
 * insert is the claim: exactly one concurrent caller wins, everyone else gets
 * false. A mail flood at quota therefore produces exactly one Telegram notice.
 */
export async function claimQuotaNotification(
  db: Db,
  userId: bigint,
  reason: QuotaNoticeReason,
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
