import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { eq, and, isNotNull, inArray, lt, count, gte } from "drizzle-orm";
import { deliveryLogs, type DeliveryLog, type NewDeliveryLog } from "../schema.js";
import type * as schema from "../schema.js";

type Db = NodePgDatabase<typeof schema>;

/**
 * Returns the first day of `month` (UTC) as a Date.
 * `month` must be in YYYY-MM format.
 */
export function monthStart(month: string): Date {
  if (!/^\d{4}-\d{2}$/.test(month)) {
    throw new Error(`monthStart: invalid month '${month}', expected YYYY-MM`);
  }
  const m = parseInt(month.slice(5, 7), 10);
  if (m < 1 || m > 12) {
    throw new Error(`monthStart: month value out of range in '${month}' (expected 01–12)`);
  }
  return new Date(`${month}-01T00:00:00.000Z`);
}

/**
 * Returns the first day of the month AFTER `month` (UTC) as a Date,
 * giving an exclusive upper bound for `received_at < end`.
 */
export function nextMonthStart(month: string): Date {
  const start = monthStart(month);
  return new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
}

/**
 * Returns null when the INSERT violates the dedup unique indexes
 * (PG error 23505), so the pipeline can treat the race as a duplicate.
 */
export async function createDeliveryLog(
  db: Db,
  data: Omit<NewDeliveryLog, "createdAt" | "receivedAt">,
): Promise<DeliveryLog | null> {
  try {
    const [log] = await db.insert(deliveryLogs).values(data).returning();
    if (!log) throw new Error("createDeliveryLog: no row returned");
    return log;
  } catch (err: unknown) {
    // 23505 = unique_violation — another pipeline inserted the same email
    // concurrently; treat this as a duplicate, not an error.
    if (
      err != null &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code: unknown }).code === "23505"
    ) {
      return null;
    }
    throw err;
  }
}

export async function findDeliveryLogByMessageId(
  db: Db,
  messageId: string,
  aliasId: string,
): Promise<DeliveryLog | null> {
  const [log] = await db
    .select()
    .from(deliveryLogs)
    .where(
      and(eq(deliveryLogs.messageIdHeader, messageId), eq(deliveryLogs.emailAddressId, aliasId)),
    );
  return log ?? null;
}

export async function findDeliveryLogByBodyHash(
  db: Db,
  bodySha256: string,
  aliasId: string,
): Promise<DeliveryLog | null> {
  const [log] = await db
    .select()
    .from(deliveryLogs)
    .where(
      and(
        eq(deliveryLogs.bodySha256, bodySha256),
        eq(deliveryLogs.emailAddressId, aliasId),
        eq(deliveryLogs.bodyDedupApplied, true),
      ),
    );
  return log ?? null;
}

export async function findDeliveryLogByRawEmailPath(
  db: Db,
  rawEmailPath: string,
): Promise<DeliveryLog | null> {
  const [log] = await db
    .select()
    .from(deliveryLogs)
    .where(eq(deliveryLogs.rawEmailPath, rawEmailPath));
  return log ?? null;
}

export async function updateDeliveryLogStatus(
  db: Db,
  id: string,
  finalStatus: string,
): Promise<void> {
  await db.update(deliveryLogs).set({ finalStatus }).where(eq(deliveryLogs.id, id));
}

export async function findLogsNeedingRetry(db: Db, receivedBefore: Date): Promise<DeliveryLog[]> {
  return db
    .select()
    .from(deliveryLogs)
    .where(
      and(
        isNotNull(deliveryLogs.rawEmailPath),
        lt(deliveryLogs.receivedAt, receivedBefore),
        inArray(deliveryLogs.finalStatus, ["failed", "received", "processing", "retrying"]),
      ),
    );
}

export async function claimDeliveryLogForRetry(
  db: Db,
  id: string,
  expectedStatuses: readonly string[] = ["failed", "received", "processing", "retrying"],
): Promise<boolean> {
  const rows = await db
    .update(deliveryLogs)
    .set({ finalStatus: "retrying" })
    .where(and(eq(deliveryLogs.id, id), inArray(deliveryLogs.finalStatus, [...expectedStatuses])))
    .returning({ id: deliveryLogs.id });
  return rows.length > 0;
}

export async function countRecentDeliveriesByAlias(
  db: Db,
  aliasId: string,
  receivedSince: Date,
): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(deliveryLogs)
    .where(
      and(eq(deliveryLogs.emailAddressId, aliasId), gte(deliveryLogs.receivedAt, receivedSince)),
    );
  return Number(row?.n ?? 0);
}

/**
 * Counts delivery_logs rows for an organization in a given calendar month (UTC),
 * filtered by finalStatus values. Used to expose Telegram delivery success/failure
 * counts in /usage independently from the billable accepted/rejected counters in
 * `organization_usage_months`.
 */
export async function countDeliveryLogsByOrgInMonth(
  db: Db,
  organizationId: string,
  month: string,
  statuses: readonly string[],
): Promise<number> {
  if (statuses.length === 0) return 0;
  const start = monthStart(month);
  const end = nextMonthStart(month);
  const [row] = await db
    .select({ n: count() })
    .from(deliveryLogs)
    .where(
      and(
        eq(deliveryLogs.organizationId, organizationId),
        gte(deliveryLogs.receivedAt, start),
        lt(deliveryLogs.receivedAt, end),
        inArray(deliveryLogs.finalStatus, [...statuses]),
      ),
    );
  return Number(row?.n ?? 0);
}
