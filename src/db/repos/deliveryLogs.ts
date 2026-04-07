import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { eq, and, isNotNull, inArray, lt, count, gte } from "drizzle-orm";
import { deliveryLogs, type DeliveryLog, type NewDeliveryLog } from "../schema.js";
import type * as schema from "../schema.js";

type Db = NodePgDatabase<typeof schema>;

/**
 * Returns null when the INSERT violates the dedup unique indexes
 * (PG error 23505), so the pipeline can treat the race as a duplicate.
 */
export async function createDeliveryLog(
  db: Db,
  data: Omit<NewDeliveryLog, "id" | "createdAt" | "receivedAt">,
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
