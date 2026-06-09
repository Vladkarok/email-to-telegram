import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { and, count, eq, isNull, notInArray, or } from "drizzle-orm";
import { deliveryAttempts, type NewDeliveryAttempt } from "../schema.js";
import type * as schema from "../schema.js";

type Db = NodePgDatabase<typeof schema>;

export async function insertDeliveryAttempt(
  db: Db,
  data: Omit<NewDeliveryAttempt, "id" | "createdAt">,
): Promise<void> {
  // Idempotent on (deliveryLogId, attemptNo): if the post-send persistence
  // transaction is retried after an ambiguous failure, the re-inserted row is
  // skipped rather than duplicated (which would skew countAttemptsByLog).
  await db
    .insert(deliveryAttempts)
    .values(data)
    .onConflictDoNothing({
      target: [deliveryAttempts.deliveryLogId, deliveryAttempts.attemptNo],
    });
}

export async function countAttemptsByLog(db: Db, deliveryLogId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(deliveryAttempts)
    .where(eq(deliveryAttempts.deliveryLogId, deliveryLogId));
  return Number(row?.n ?? 0);
}

/**
 * Counts the failed attempts that consume the retry budget. Failed attempts
 * whose error class is in `uncountedClasses` (global-transient: Telegram or
 * the network being down) are excluded; rows with a NULL class (recorded
 * before the column existed) stay counted so old data cannot extend its own
 * budget.
 */
export async function countCountedFailedAttemptsByLog(
  db: Db,
  deliveryLogId: string,
  uncountedClasses: readonly string[],
): Promise<number> {
  const failedForLog = and(
    eq(deliveryAttempts.deliveryLogId, deliveryLogId),
    eq(deliveryAttempts.status, "failed"),
  );
  const [row] = await db
    .select({ n: count() })
    .from(deliveryAttempts)
    .where(
      uncountedClasses.length === 0
        ? failedForLog
        : and(
            failedForLog,
            or(
              isNull(deliveryAttempts.errorClass),
              notInArray(deliveryAttempts.errorClass, [...uncountedClasses]),
            ),
          ),
    );
  return Number(row?.n ?? 0);
}
