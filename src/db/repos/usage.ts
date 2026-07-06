import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { and, count, eq, gt, sql } from "drizzle-orm";
import { userUsageMonths, type NewUserUsageMonth, type UserUsageMonth } from "../schema.js";
import type * as schema from "../schema.js";

type Db = NodePgDatabase<typeof schema>;

export function usageMonthForDate(date = new Date()): string {
  return date.toISOString().slice(0, 7);
}

export async function getUserUsageMonth(
  db: Db,
  userId: bigint,
  month: string,
): Promise<UserUsageMonth | null> {
  const [usage] = await db
    .select()
    .from(userUsageMonths)
    .where(and(eq(userUsageMonths.userId, userId), eq(userUsageMonths.month, month)));
  return usage ?? null;
}

/**
 * Users whose usage counter shows accepted mail in `month`. delivered_count
 * increments when mail is accepted into durable processing (queue.ts), NOT
 * when the Telegram send succeeds — later send failures still count. Callers
 * must not present this as "received/delivered".
 */
export async function countUsersWithAcceptedMailInMonth(db: Db, month: string): Promise<number> {
  const [row] = await db
    .select({ count: count() })
    .from(userUsageMonths)
    .where(and(eq(userUsageMonths.month, month), gt(userUsageMonths.deliveredCount, 0)));
  return Number(row?.count ?? 0);
}

export async function incrementUserUsageMonth(
  db: Db,
  data: Pick<NewUserUsageMonth, "userId" | "month"> & {
    deliveredCount?: number;
    rejectedCount?: number;
    egressBytes?: bigint;
  },
): Promise<UserUsageMonth> {
  const deliveredCount = data.deliveredCount ?? 0;
  const rejectedCount = data.rejectedCount ?? 0;
  const egressBytes = data.egressBytes ?? 0n;
  if (deliveredCount < 0 || rejectedCount < 0 || egressBytes < 0n) {
    throw new Error("Usage increments must be non-negative");
  }

  const [usage] = await db
    .insert(userUsageMonths)
    .values({
      userId: data.userId,
      month: data.month,
      deliveredCount,
      rejectedCount,
      egressBytes,
    })
    .onConflictDoUpdate({
      target: [userUsageMonths.userId, userUsageMonths.month],
      set: {
        deliveredCount: sql`${userUsageMonths.deliveredCount} + ${deliveredCount}`,
        rejectedCount: sql`${userUsageMonths.rejectedCount} + ${rejectedCount}`,
        egressBytes: sql`${userUsageMonths.egressBytes} + ${egressBytes}`,
        updatedAt: new Date(),
      },
    })
    .returning();
  if (!usage) throw new Error("incrementUserUsageMonth: no row returned");
  return usage;
}

export async function decrementUserUsageMonth(
  db: Db,
  data: Pick<NewUserUsageMonth, "userId" | "month"> & {
    deliveredCount?: number;
    rejectedCount?: number;
    egressBytes?: bigint;
  },
): Promise<UserUsageMonth> {
  const deliveredCount = data.deliveredCount ?? 0;
  const rejectedCount = data.rejectedCount ?? 0;
  const egressBytes = data.egressBytes ?? 0n;
  if (deliveredCount < 0 || rejectedCount < 0 || egressBytes < 0n) {
    throw new Error("Usage decrements must be non-negative");
  }

  const [usage] = await db
    .update(userUsageMonths)
    .set({
      deliveredCount: sql`greatest(${userUsageMonths.deliveredCount} - ${deliveredCount}, 0)`,
      rejectedCount: sql`greatest(${userUsageMonths.rejectedCount} - ${rejectedCount}, 0)`,
      egressBytes: sql`greatest(${userUsageMonths.egressBytes} - ${egressBytes}, 0)`,
      updatedAt: new Date(),
    })
    .where(and(eq(userUsageMonths.userId, data.userId), eq(userUsageMonths.month, data.month)))
    .returning();
  if (!usage) throw new Error("decrementUserUsageMonth: no row returned");
  return usage;
}
