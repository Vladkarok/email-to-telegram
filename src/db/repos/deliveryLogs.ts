import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { eq, and, isNotNull } from "drizzle-orm";
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
    .where(and(eq(deliveryLogs.bodySha256, bodySha256), eq(deliveryLogs.emailAddressId, aliasId)));
  return log ?? null;
}

export async function updateDeliveryLogStatus(
  db: Db,
  id: string,
  finalStatus: string,
): Promise<void> {
  await db.update(deliveryLogs).set({ finalStatus }).where(eq(deliveryLogs.id, id));
}

export async function findFailedLogs(db: Db): Promise<DeliveryLog[]> {
  return db
    .select()
    .from(deliveryLogs)
    .where(and(eq(deliveryLogs.finalStatus, "failed"), isNotNull(deliveryLogs.rawEmailPath)));
}
