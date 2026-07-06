import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../db/schema.js";
import { decrementUserUsageMonth, usageMonthForDate } from "../db/repos/usage.js";
import { getLogger } from "../utils/logger.js";

type Db = NodePgDatabase<typeof schema>;

/**
 * Refunds the monthly-quota charge for an accepted email whose delivery
 * permanently failed. The charge happened at acceptance (queue.ts), so the
 * refund targets the month the email was RECEIVED in — not the current month —
 * or a permanent failure just after a month boundary would corrupt the fresh
 * counter.
 *
 * Best-effort and never throws: the permanently_failed status is already
 * persisted when this runs, and a crash between the two loses at most one
 * refund. decrementUserUsageMonth clamps at zero, so a double call cannot go
 * negative.
 */
export async function refundAcceptedEmail(
  db: Db,
  input: { deliveryLogId: string; userId: bigint | null; receivedAt: Date },
): Promise<void> {
  // Legacy/self-hosted delivery logs can lack a user id — no tenant, no quota,
  // nothing to refund.
  if (input.userId == null) return;
  const month = usageMonthForDate(input.receivedAt);
  try {
    await decrementUserUsageMonth(db, {
      userId: input.userId,
      month,
      deliveredCount: 1,
    });
    getLogger().info(
      { deliveryLogId: input.deliveryLogId, userId: String(input.userId), month },
      "usage.refund.permanent_failure",
    );
  } catch (err: unknown) {
    getLogger().warn(
      { err, deliveryLogId: input.deliveryLogId, userId: String(input.userId), month },
      "usage.refund.failed",
    );
  }
}
