import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { eq, count } from "drizzle-orm";
import { deliveryAttempts, type NewDeliveryAttempt } from "../schema.js";
import type * as schema from "../schema.js";

type Db = NodePgDatabase<typeof schema>;

export async function insertDeliveryAttempt(
  db: Db,
  data: Omit<NewDeliveryAttempt, "id" | "createdAt">,
): Promise<void> {
  await db.insert(deliveryAttempts).values(data);
}

export async function countAttemptsByLog(db: Db, deliveryLogId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(deliveryAttempts)
    .where(eq(deliveryAttempts.deliveryLogId, deliveryLogId));
  return Number(row?.n ?? 0);
}
