import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "./schema.js";

type Db = NodePgDatabase<typeof schema>;

export interface TransactionTimeouts {
  /** `SET LOCAL statement_timeout`, e.g. "5s". */
  statementTimeout: string;
  /** `SET LOCAL lock_timeout`, e.g. "2s". */
  lockTimeout: string;
}

/** Bounds for side work that must never stall the path it runs next to. */
export const SIDE_WORK_TIMEOUTS: Readonly<TransactionTimeouts> = Object.freeze({
  statementTimeout: "5s",
  lockTimeout: "2s",
});

/**
 * Runs `work` in a transaction whose statements and lock waits are bounded:
 * `set_config(…, true)` is `SET LOCAL statement_timeout` / `SET LOCAL
 * lock_timeout` in one round trip, scoped to this transaction only. A
 * timeout surfaces as an ordinary query error and rolls the transaction back.
 */
export async function withBoundedTransaction<T>(
  db: Db,
  timeouts: TransactionTimeouts,
  work: (tx: Db) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('statement_timeout', ${timeouts.statementTimeout}, true), set_config('lock_timeout', ${timeouts.lockTimeout}, true)`,
    );
    return work(tx as Db);
  });
}
