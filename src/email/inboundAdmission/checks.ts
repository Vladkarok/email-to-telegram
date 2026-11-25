/**
 * Admission checks that more than one stage runs. Each takes the caller's
 * database handle, so the queue can run them inside its locked transaction
 * and the routes on the pool.
 */
import type { Api } from "grammy";
import { findAliasForInbound } from "../inboundRouting.js";
import { findHostedInboundRejection } from "../../abuse/hostedInboundBlocklist.js";
import {
  checkInboundLimitForPlan,
  resolveInboundPlan,
  type InboundLimitCode,
  type InboundLimitResult,
  type InboundPlan,
} from "../../billing/limits.js";
import { notifyQuotaExhausted } from "../../billing/quotaNotifier.js";
import { countRecentDeliveriesByAlias } from "../../db/repos/deliveryLogs.js";
import { incrementUserUsageMonth, usageMonthForDate } from "../../db/repos/usage.js";
import type { EmailAddress, HostedInboundBlock } from "../../db/schema.js";
import { recordQuotaRejection } from "../../observability/metrics.js";
import { getLogger } from "../../utils/logger.js";
import type { Db } from "../pipeline/types.js";
import { isQuotaRejection } from "./policy.js";

/** The sliding window the hourly cap counts accepted mail in. */
const HOURLY_CAP_WINDOW_MS = 60 * 60 * 1000;

export type AliasRefusal =
  | { kind: "alias_not_found" }
  | { kind: "hosted_blocklist"; alias: EmailAddress; block: HostedInboundBlock };

export type AliasAdmission = AliasRefusal | { kind: "admitted"; alias: EmailAddress };

/** The active alias an inbound address routes to, unless the hosted blocklist refuses it. */
export async function admitAlias(
  db: Db,
  input: { localPart: string; recipientDomain?: string; envelopeFrom?: string | null },
): Promise<AliasAdmission> {
  const alias = await findAliasForInbound(db, {
    localPart: input.localPart,
    recipientDomain: input.recipientDomain,
  });
  if (!alias || alias.status !== "active") return { kind: "alias_not_found" };

  const block = await findHostedInboundRejection(db, {
    userId: alias.createdBy,
    localPart: input.localPart,
    recipientDomain: input.recipientDomain,
    envelopeFrom: input.envelopeFrom,
  });
  if (block) return { kind: "hosted_blocklist", alias, block };
  return { kind: "admitted", alias };
}

export interface PlanLimitPrecheck {
  /** One month for the whole rejection decision (check, counter, claim). */
  month: string;
  /** One plan for both the quota check and the hourly cap. */
  plan: InboundPlan;
  limit: InboundLimitResult;
}

/**
 * The unlocked plan-limit check a route runs before the queue. Sizes the
 * route does not know are left out, which skips that check.
 */
export async function precheckPlanLimit(
  db: Db,
  userId: bigint,
  sizes: { rawSizeBytes?: number; storageDeltaBytes?: bigint },
): Promise<PlanLimitPrecheck> {
  const month = usageMonthForDate();
  const plan = await resolveInboundPlan(db, userId);
  const limit = await checkInboundLimitForPlan(
    db,
    plan,
    sizes.rawSizeBytes,
    sizes.storageDeltaBytes,
    month,
  );
  return { month, plan, limit };
}

/**
 * Accounting for a route's plan-limit rejection. The counter runs in its own
 * autocommit statement; a counter failure is only logged and the notice is
 * still scheduled.
 */
export async function settlePlanLimitRejection(
  db: Db,
  api: Api | null,
  rejection: { userId: bigint; reason: InboundLimitCode; month: string },
): Promise<void> {
  const { userId, reason, month } = rejection;
  recordQuotaRejection(reason);
  if (!isQuotaRejection(reason)) return;
  // Count the rejection (shown in /usage), then notify.
  await incrementUserUsageMonth(db, { userId, month, rejectedCount: 1 }).catch((err: unknown) => {
    getLogger().warn({ err, userId: userId.toString() }, "quota.rejection.count_failed");
  });
  void notifyQuotaExhausted(db, api, userId, reason, month);
}

/**
 * Whether the alias already accepted its plan's hourly cap of mail. The
 * window ends when this is called, so a caller holding locks measures it
 * after any lock wait. Every logged status counts.
 */
export async function isOverHourlyCap(
  db: Db,
  aliasId: string,
  plan: InboundPlan,
): Promise<boolean> {
  const recentDeliveries = await countRecentDeliveriesByAlias(
    db,
    aliasId,
    new Date(Date.now() - HOURLY_CAP_WINDOW_MS),
  );
  return recentDeliveries >= plan.plan.limits.aliasEmailsPerHour;
}
