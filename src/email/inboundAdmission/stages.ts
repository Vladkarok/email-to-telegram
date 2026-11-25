/**
 * The route stages of inbound admission. Each returns its verdict in the
 * order the checks run, which decides the reason reported; the routes turn
 * the verdict into HTTP and metrics.
 */
import { checkPreflightAllowRules } from "../../db/repos/allowRules.js";
import type { InboundLimitCode } from "../../billing/limits.js";
import type { EmailAddress } from "../../db/schema.js";
import type { Db } from "../pipeline/types.js";
import { admitAlias, isOverHourlyCap, precheckPlanLimit, type AliasRefusal } from "./checks.js";
import { REJECTION_POLICY, type RejectionPolicy } from "./policy.js";

/** A plan-limit refusal whose accounting the route settles after its metric. */
export interface PlanLimitRejection {
  reason: InboundLimitCode;
  alias: EmailAddress;
  userId: bigint;
  month: string;
}

export type PreflightVerdict =
  | AliasRefusal
  | ({ kind: "plan_limit" } & PlanLimitRejection)
  /** The alias has no allow rules at all. */
  | { kind: "no_allow_rules"; alias: EmailAddress }
  | { kind: "hourly_cap"; alias: EmailAddress }
  | { kind: "accepted"; alias: EmailAddress };

/**
 * Preflight runs before the Worker reads the message: it has no MIME, so no
 * sender authentication, dedup or size, and it reserves and charges nothing.
 */
export async function admitPreflight(
  db: Db,
  input: { localPart: string; recipientDomain?: string; envelopeFrom: string | null },
): Promise<PreflightVerdict> {
  const admitted = await admitAlias(db, input);
  if (admitted.kind !== "admitted") return admitted;
  const { alias } = admitted;

  // Neither size nor storage is known here, so storage exhaustion cannot be
  // reached at preflight.
  const { month, plan, limit } = await precheckPlanLimit(db, alias.createdBy, {});
  if (!limit.ok) {
    return { kind: "plan_limit", reason: limit.code, alias, userId: alias.createdBy, month };
  }

  // Preflight has no raw MIME, so it cannot verify DKIM/DMARC. It only
  // rejects aliases with no allow rules; final sender authorization happens
  // in the raw pipeline.
  if (!(await checkPreflightAllowRules(db, alias.id))) return { kind: "no_allow_rules", alias };

  // Unlocked: the queue repeats the test under its locks.
  if (await isOverHourlyCap(db, alias.id, plan)) return { kind: "hourly_cap", alias };

  return { kind: "accepted", alias };
}

export type RawPrecheckVerdict =
  | AliasRefusal
  | ({ kind: "plan_limit"; status: RejectionPolicy["rawStatus"] } & PlanLimitRejection)
  | { kind: "accepted"; alias: EmailAddress };

/**
 * The raw route's check before it stores the mail. Sender, dedup and the
 * hourly cap are left to the queue, which repeats the plan check under its
 * locks with the parsed attachment sizes.
 */
export async function admitRawPrecheck(
  db: Db,
  input: {
    localPart: string;
    recipientDomain?: string;
    envelopeFrom?: string;
    rawSizeBytes: number;
  },
): Promise<RawPrecheckVerdict> {
  const admitted = await admitAlias(db, input);
  if (admitted.kind !== "admitted") return admitted;
  const { alias } = admitted;

  // The raw length stands in for both the message size and the storage delta.
  const { month, limit } = await precheckPlanLimit(db, alias.createdBy, {
    rawSizeBytes: input.rawSizeBytes,
    storageDeltaBytes: BigInt(input.rawSizeBytes),
  });
  if (!limit.ok) {
    const { rawStatus } = REJECTION_POLICY[limit.code];
    return {
      kind: "plan_limit",
      status: rawStatus,
      reason: limit.code,
      alias,
      userId: alias.createdBy,
      month,
    };
  }

  return { kind: "accepted", alias };
}
