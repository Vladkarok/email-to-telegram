import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { incrementUserUsageMonth, usageMonthForDate } from "../db/repos/usage.js";
import type * as schema from "../db/schema.js";
import { checkEgressLimit, type LimitResult, withUserQuotaLock } from "./limits.js";

type Db = NodePgDatabase<typeof schema>;

export interface EgressChargeInput<T> {
  /** The owner whose monthly egress is checked and counted; null for none. */
  ownerUserId: bigint | null;
  /** The moment that fixes the usage month; defaults to now. */
  at?: Date;
  /**
   * What a refusal (over the limit, or the claim lost) does to the owner's
   * transaction: "rollback" undoes every write `prepare` made, "commit" keeps
   * them. Only hosted mode with a known owner has a transaction; elsewhere the
   * scope is the caller's own handle and writes are kept either way.
   */
  onRefusal: "commit" | "rollback";
  /**
   * Runs first inside the charge scope and says how many bytes this request
   * will serve.
   */
  prepare: (tx: Db) => Promise<{ egressBytes: bigint; value: T }>;
  /** The one-time claim; false means another request already took it. */
  claim: (tx: Db) => Promise<boolean>;
}

export type EgressChargeResult<T> =
  | { status: "charged"; month: string; egressBytes: bigint; value: T }
  | { status: "over_limit"; month: string; limit: Exclude<LimitResult, { ok: true }> }
  | { status: "claim_lost"; month: string };

type EgressChargeRefusal = Exclude<EgressChargeResult<never>, { status: "charged" }>;

// Thrown, not returned, under onRefusal "rollback", so the refusal rolls back
// the owner's transaction and with it every write `prepare` made; translated
// to a result at the edge.
class EgressChargeRefused extends Error {
  constructor(readonly outcome: EgressChargeRefusal) {
    super(`egress charge refused: ${outcome.status}`);
  }
}

/**
 * Charges one served response against the owner's monthly egress: prepare,
 * check the limit, take the one-time claim, count the bytes. All of it runs
 * under `withUserQuotaLock`, so in hosted mode with a known owner the check
 * and the count see one locked month and commit with the claim, and two
 * requests at the edge of the limit cannot both pass. Self-hosted mode and a
 * null owner run on `db` as given; self-hosted still counts positive egress
 * for a known owner.
 *
 * The month is resolved once, before the lock wait, and returned so that a
 * caller compensating unserved bytes later uses the month it was charged in.
 */
export async function chargeEgress<T>(
  db: Db,
  input: EgressChargeInput<T>,
): Promise<EgressChargeResult<T>> {
  const { ownerUserId } = input;
  const month = usageMonthForDate(input.at);
  try {
    return await withUserQuotaLock(db, ownerUserId, async (tx): Promise<EgressChargeResult<T>> => {
      const refuse = (outcome: EgressChargeRefusal): EgressChargeRefusal => {
        if (input.onRefusal === "rollback") throw new EgressChargeRefused(outcome);
        return outcome;
      };
      const { egressBytes, value } = await input.prepare(tx);

      const limit = await checkEgressLimit(tx, ownerUserId, egressBytes, month);
      if (!limit.ok) return refuse({ status: "over_limit", month, limit });

      if (!(await input.claim(tx))) return refuse({ status: "claim_lost", month });

      if (ownerUserId != null && egressBytes > 0n) {
        await incrementUserUsageMonth(tx, { userId: ownerUserId, month, egressBytes });
      }

      return { status: "charged" as const, month, egressBytes, value };
    });
  } catch (err: unknown) {
    if (err instanceof EgressChargeRefused) return err.outcome;
    throw err;
  }
}
