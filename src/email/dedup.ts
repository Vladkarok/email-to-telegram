import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../db/schema.js";
import { findDeliveryLogByMessageId, findDeliveryLogByBodyHash } from "../db/repos/deliveryLogs.js";

type Db = NodePgDatabase<typeof schema>;

interface DedupInput {
  messageId: string | null;
  bodySha256: string;
  aliasId: string;
}

export async function isDuplicate(db: Db, input: DedupInput): Promise<boolean> {
  if (input.messageId) {
    const existing = await findDeliveryLogByMessageId(db, input.messageId, input.aliasId);
    if (existing) return true;
  }

  const existing = await findDeliveryLogByBodyHash(db, input.bodySha256, input.aliasId);
  return existing !== null;
}
