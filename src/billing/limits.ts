import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { loadConfig } from "../config.js";
import { getPlanDefinition, type PlanCode, type PlanDefinition } from "./plans.js";
import { countActiveAliasesByOrganization } from "../db/repos/aliases.js";
import { countAllowRulesByOrganization } from "../db/repos/allowRules.js";
import { findOrganizationById } from "../db/repos/organizations.js";
import { getOrganizationStorageUsage } from "../db/repos/storageUsage.js";
import { getOrganizationUsageMonth, usageMonthForDate } from "../db/repos/usage.js";
import type { Organization } from "../db/schema.js";
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
  organization: Pick<
    Organization,
    "planCode" | "subscriptionStatus" | "currentPeriodEnd" | "paidThroughAt"
  >,
): PlanDefinition {
  if (organization.planCode === "free") return getPlanDefinition("free");

  if (organization.planCode === "business") return getPlanDefinition("business");

  switch (organization.subscriptionStatus) {
    case "trialing":
    case "active":
      return getPlanDefinition(organization.planCode as PlanCode);
    case "past_due":
      if (
        organization.paidThroughAt &&
        Date.now() - organization.paidThroughAt.getTime() <= PAST_DUE_GRACE_MS
      ) {
        return getPlanDefinition(organization.planCode as PlanCode);
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

export async function checkAliasCreateLimit(
  db: Db,
  organizationId: string | null,
): Promise<LimitResult> {
  if (!shouldEnforceHostedLimits()) return { ok: true };
  if (!organizationId) return { ok: false, code: "subscription_inactive" };

  const organization = await findOrganizationById(db, organizationId);
  if (!organization) return { ok: false, code: "subscription_inactive" };

  const plan = getEffectivePlan(organization);
  const used = await countActiveAliasesByOrganization(db, organization.id);
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
  organizationId: string | null,
): Promise<LimitResult> {
  if (!shouldEnforceHostedLimits()) return { ok: true };
  if (!organizationId) return { ok: false, code: "subscription_inactive" };

  const organization = await findOrganizationById(db, organizationId);
  if (!organization) return { ok: false, code: "subscription_inactive" };

  const plan = getEffectivePlan(organization);
  const used = await countAllowRulesByOrganization(db, organization.id);
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
  organizationId: string | null,
  rawSizeBytes?: number,
  storageDeltaBytes?: bigint,
): Promise<LimitResult> {
  if (!shouldEnforceHostedLimits()) return { ok: true };
  if (!organizationId) return { ok: false, code: "subscription_inactive" };

  const organization = await findOrganizationById(db, organizationId);
  if (!organization) return { ok: false, code: "subscription_inactive" };

  const plan = getEffectivePlan(organization);
  if (rawSizeBytes != null && rawSizeBytes > plan.limits.maxMessageBytes) {
    return {
      ok: false,
      code: "message_size_limit",
      limit: plan.limits.maxMessageBytes,
      used: rawSizeBytes,
    };
  }

  if (storageDeltaBytes != null && storageDeltaBytes > 0n) {
    const storage = await getOrganizationStorageUsage(db, organization.id);
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

  const usage = await getOrganizationUsageMonth(db, organization.id, usageMonthForDate());
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
  organizationId: string | null,
  egressBytes: bigint,
  month = usageMonthForDate(),
): Promise<LimitResult> {
  if (!shouldEnforceHostedLimits()) return { ok: true };
  if (!organizationId) return { ok: false, code: "subscription_inactive" };
  if (egressBytes <= 0n) return { ok: true };

  const organization = await findOrganizationById(db, organizationId);
  if (!organization) return { ok: false, code: "subscription_inactive" };

  const plan = getEffectivePlan(organization);
  const usage = await getOrganizationUsageMonth(db, organization.id, month);
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

export async function hasActiveHostedOrganization(
  db: Db,
  organizationId: string | null,
): Promise<boolean> {
  if (!shouldEnforceHostedLimits()) return true;
  if (!organizationId) return false;

  const organization = await findOrganizationById(db, organizationId);
  return Boolean(organization);
}

function shouldEnforceHostedLimits(): boolean {
  const appMode = process.env["APP_MODE"];
  if (appMode === "hosted") return true;
  if (appMode === "self-hosted") return false;

  try {
    return loadConfig().appMode === "hosted";
  } catch {
    return false;
  }
}

export async function withOrganizationQuotaLock<T>(
  db: Db,
  organizationId: string | null,
  work: (tx: Db) => Promise<T>,
): Promise<T> {
  if (!shouldEnforceHostedLimits() || !organizationId) {
    return work(db);
  }

  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${organizationId}))`);
    return work(tx as Db);
  });
}
