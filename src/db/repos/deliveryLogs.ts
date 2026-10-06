import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { eq, and, or, isNull, isNotNull, inArray, lt, count, gte, min } from "drizzle-orm";
import { deliveryLogs, type DeliveryLog, type NewDeliveryLog } from "../schema.js";
import type * as schema from "../schema.js";

type Db = NodePgDatabase<typeof schema>;

/**
 * `final_status` values a delivery log can still leave: queued (`received`),
 * mid-delivery (`processing`), claimed by the retry worker (`retrying`), or
 * waiting for it (`failed`). `delivered` and `permanently_failed` are final.
 */
export const NON_FINAL_DELIVERY_STATUSES = [
  "received",
  "processing",
  "retrying",
  "failed",
] as const;
export type NonFinalDeliveryStatus = (typeof NON_FINAL_DELIVERY_STATUSES)[number];

export interface DeliveryBacklogSummary {
  counts: Partial<Record<NonFinalDeliveryStatus, number>>;
  /** received_at of the oldest non-final log; null when there is none. */
  oldestReceivedAt: Date | null;
}

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

/**
 * Marks a delivery log as "processing" and stamps processing_started_at, so the
 * retry worker can tell an in-progress delivery from a stranded one.
 */
export async function markDeliveryLogProcessing(db: Db, id: string): Promise<void> {
  await db
    .update(deliveryLogs)
    .set({ finalStatus: "processing", processingStartedAt: new Date() })
    .where(eq(deliveryLogs.id, id));
}

/**
 * Finds delivery logs the retry worker should re-attempt. `failed`/`received`/
 * `retrying` rows qualify once older than `receivedBefore`. A `processing` row
 * additionally must have a stale (or absent) `processingStartedAt` — otherwise
 * it is assumed to be an in-progress delivery owned by a live process.
 */
export async function findLogsNeedingRetry(
  db: Db,
  receivedBefore: Date,
  processingStaleBefore: Date,
): Promise<DeliveryLog[]> {
  return db
    .select()
    .from(deliveryLogs)
    .where(
      and(
        isNotNull(deliveryLogs.rawEmailPath),
        lt(deliveryLogs.receivedAt, receivedBefore),
        or(
          inArray(deliveryLogs.finalStatus, ["failed", "received", "retrying"]),
          and(
            eq(deliveryLogs.finalStatus, "processing"),
            or(
              isNull(deliveryLogs.processingStartedAt),
              lt(deliveryLogs.processingStartedAt, processingStaleBefore),
            ),
          ),
        ),
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

/**
 * The delivery backlog for /metrics: non-final logs per status and the oldest
 * one's received_at, in one grouped query. The partial index
 * idx_log_backlog_received covers exactly these rows, which stay few (cleanup
 * closes them once the raw email expires), so no full scan per scrape.
 */
export async function summarizeDeliveryBacklog(db: Db): Promise<DeliveryBacklogSummary> {
  const rows = await db
    .select({
      status: deliveryLogs.finalStatus,
      count: count(),
      oldest: min(deliveryLogs.receivedAt),
    })
    .from(deliveryLogs)
    .where(inArray(deliveryLogs.finalStatus, [...NON_FINAL_DELIVERY_STATUSES]))
    .groupBy(deliveryLogs.finalStatus);

  const counts: DeliveryBacklogSummary["counts"] = {};
  let oldestReceivedAt: Date | null = null;
  for (const row of rows) {
    counts[row.status as NonFinalDeliveryStatus] = Number(row.count);
    if (row.oldest && (oldestReceivedAt === null || row.oldest < oldestReceivedAt)) {
      oldestReceivedAt = row.oldest;
    }
  }
  return { counts, oldestReceivedAt };
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
 * Counts delivery_logs rows for a user in a given calendar month (UTC),
 * filtered by finalStatus values. Used to expose Telegram delivery success/failure
 * counts in /usage independently from the billable accepted/rejected counters in
 * `user_usage_months`.
 */
export async function countDeliveryLogsByUserInMonth(
  db: Db,
  userId: bigint,
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
        eq(deliveryLogs.userId, userId),
        gte(deliveryLogs.receivedAt, start),
        lt(deliveryLogs.receivedAt, end),
        inArray(deliveryLogs.finalStatus, [...statuses]),
      ),
    );
  return Number(row?.n ?? 0);
}
