import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../db/schema.js";
import type { NoticeBounds } from "./bounds.js";

type Db = NodePgDatabase<typeof schema>;

/**
 * Runs `work` in a transaction whose statements and lock waits are bounded:
 * `set_config(…, true)` is `SET LOCAL statement_timeout` / `SET LOCAL
 * lock_timeout` in one round trip, scoped to this transaction only.
 */
export async function withBoundedTransaction<T>(
  db: Db,
  bounds: Pick<NoticeBounds, "statementTimeout" | "lockTimeout">,
  work: (tx: Db) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('statement_timeout', ${bounds.statementTimeout}, true), set_config('lock_timeout', ${bounds.lockTimeout}, true)`,
    );
    return work(tx as Db);
  });
}
