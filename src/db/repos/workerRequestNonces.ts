import { createHash } from "crypto";
import { lt } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { workerRequestNonces } from "../schema.js";
import type * as schema from "../schema.js";

type Db = NodePgDatabase<typeof schema>;

export async function claimWorkerRequestNonce(
  db: Db,
  signature: string,
  requestTimestamp: Date,
): Promise<boolean> {
  const signatureHash = createHash("sha256").update(signature).digest("hex");
  const cutoff = new Date(Date.now() - 10 * 60 * 1000);
  await db.delete(workerRequestNonces).where(lt(workerRequestNonces.createdAt, cutoff));

  const rows = await db
    .insert(workerRequestNonces)
    .values({ signatureHash, requestTimestamp })
    .onConflictDoNothing()
    .returning({ signatureHash: workerRequestNonces.signatureHash });

  return rows.length > 0;
}
