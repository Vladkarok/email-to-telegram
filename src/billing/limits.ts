import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { loadConfig } from "../config.js";
import { getPlanDefinition, type PlanCode, type PlanDefinition } from "./plans.js";
import { countActiveAliasesByUser } from "../db/repos/aliases.js";
import { countAllowRulesByUser } from "../db/repos/allowRules.js";
import { findUserById } from "../db/repos/users.js";
import { getUserStorageUsage } from "../db/repos/storageUsage.js";
import { getUserUsageMonth, usageMonthForDate } from "../db/repos/usage.js";
import type { User } from "../db/schema.js";
import type * as schema from "../db/schema.js";

type Db = NodePgDatabase<typeof schema>;

export type LimitResult =
  | { ok: true }
  | {
      ok: false;
      code:
        | "subscription_inactive"
        | "alias_limit"
        | "allow_rule_limit"
        | "monthly_email_limit"
        | "storage_limit"
        | "message_size_limit"
        | "egress_limit";
      limit?: number;
      used?: number;
    };

const PAST_DUE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

export function getEffectivePlan(
  user: Pick<User, "planCode" | "subscriptionStatus" | "currentPeriodEnd" | "paidThroughAt">,
): PlanDefinition {
  if (user.planCode === "free") return getPlanDefinition("free");

  if (user.planCode === "business") return getPlanDefinition("business");

  switch (user.subscriptionStatus) {
    case "trialing":
    case "active":
      return getPlanDefinition(user.planCode as PlanCode);
    case "past_due":
      if (user.paidThroughAt && Date.now() - user.paidThroughAt.getTime() <= PAST_DUE_GRACE_MS) {
        return getPlanDefinition(user.planCode as PlanCode);
      }
      return getPlanDefinition("free");
    case "paused":
    case "free":
    case "canceled":
    case "unpaid":
    case "incomplete":
    default:
      return getPlanDefinition("free");
  }
}

export async function checkAliasCreateLimit(db: Db, userId: bigint | null): Promise<LimitResult> {
  if (!shouldEnforceHostedLimits()) return { ok: true };
  if (userId == null) return { ok: false, code: "subscription_inactive" };

  const user = await findUserById(db, userId);
  if (!user) return { ok: false, code: "subscription_inactive" };

  const plan = getEffectivePlan(user);
  const used = await countActiveAliasesByUser(db, user.id);
  if (used >= plan.limits.aliases) {
    return {
      ok: false,
      code: "alias_limit",
      limit: plan.limits.aliases,
      used,
    };
  }

  return { ok: true };
}

export async function checkAllowRuleCreateLimit(
  db: Db,
  userId: bigint | null,
): Promise<LimitResult> {
  if (!shouldEnforceHostedLimits()) return { ok: true };
  if (userId == null) return { ok: false, code: "subscription_inactive" };

  const user = await findUserById(db, userId);
  if (!user) return { ok: false, code: "subscription_inactive" };

  const plan = getEffectivePlan(user);
  const used = await countAllowRulesByUser(db, user.id);
  if (used >= plan.limits.allowRules) {
    return {
      ok: false,
      code: "allow_rule_limit",
      limit: plan.limits.allowRules,
      used,
    };
  }

  return { ok: true };
}

export async function checkInboundLimit(
  db: Db,
  userId: bigint | null,
  rawSizeBytes?: number,
  storageDeltaBytes?: bigint,
  // Callers pass the month they captured for the whole rejection decision so
  // that check, counter increment, and notification claim cannot straddle a
  // UTC month boundary and disagree.
  month = usageMonthForDate(),
): Promise<LimitResult> {
  if (!shouldEnforceHostedLimits()) return { ok: true };
  if (userId == null) return { ok: false, code: "subscription_inactive" };

  const user = await findUserById(db, userId);
  if (!user) return { ok: false, code: "subscription_inactive" };

  const plan = getEffectivePlan(user);
  if (rawSizeBytes != null && rawSizeBytes > plan.limits.maxMessageBytes) {
    return {
      ok: false,
      code: "message_size_limit",
      limit: plan.limits.maxMessageBytes,
      used: rawSizeBytes,
    };
  }

  if (storageDeltaBytes != null && storageDeltaBytes > 0n) {
    const storage = await getUserStorageUsage(db, user.id);
    const currentBytes = (storage?.rawEmailBytes ?? 0n) + (storage?.attachmentBytes ?? 0n);
    const projectedBytes = currentBytes + storageDeltaBytes;
    if (projectedBytes > BigInt(plan.limits.storageBytes)) {
      return {
        ok: false,
        code: "storage_limit",
        limit: plan.limits.storageBytes,
        used: Number(currentBytes),
      };
    }
  }

  const usage = await getUserUsageMonth(db, user.id, month);
  const deliveredCount = usage?.deliveredCount ?? 0;
  if (deliveredCount >= plan.limits.deliveredEmailsMonth) {
    return {
      ok: false,
      code: "monthly_email_limit",
      limit: plan.limits.deliveredEmailsMonth,
      used: deliveredCount,
    };
  }

  return { ok: true };
}

export async function checkEgressLimit(
  db: Db,
  userId: bigint | null,
  egressBytes: bigint,
  month = usageMonthForDate(),
): Promise<LimitResult> {
  if (!shouldEnforceHostedLimits()) return { ok: true };
  if (userId == null) return { ok: false, code: "subscription_inactive" };
  if (egressBytes <= 0n) return { ok: true };

  const user = await findUserById(db, userId);
  if (!user) return { ok: false, code: "subscription_inactive" };

  const plan = getEffectivePlan(user);
  const usage = await getUserUsageMonth(db, user.id, month);
  const currentBytes = usage?.egressBytes ?? 0n;
  const projectedBytes = currentBytes + egressBytes;
  if (projectedBytes > BigInt(plan.limits.egressBytesMonth)) {
    return {
      ok: false,
      code: "egress_limit",
      limit: plan.limits.egressBytesMonth,
      used: Number(currentBytes),
    };
  }

  return { ok: true };
}

export async function hasActiveHostedUser(db: Db, userId: bigint | null): Promise<boolean> {
  if (!shouldEnforceHostedLimits()) return true;
  if (userId == null) return false;

  const user = await findUserById(db, userId);
  return Boolean(user);
}

export function shouldEnforceHostedLimits(): boolean {
  const appMode = process.env["APP_MODE"];
  if (appMode === "hosted") return true;
  if (appMode === "self-hosted") return false;

  try {
    return loadConfig().appMode === "hosted";
  } catch {
    return false;
  }
}

export async function withUserQuotaLock<T>(
  db: Db,
  userId: bigint | null,
  work: (tx: Db) => Promise<T>,
): Promise<T> {
  if (!shouldEnforceHostedLimits() || userId == null) {
    return work(db);
  }

  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${userId})`);
    return work(tx as Db);
  });
}
