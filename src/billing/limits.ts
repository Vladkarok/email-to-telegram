import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { loadConfig } from "../config.js";
import { getPlanDefinition, type PlanCode, type PlanDefinition } from "./plans.js";
import { countActiveAliasesByOrganization } from "../db/repos/aliases.js";
import { countAllowRulesByOrganization } from "../db/repos/allowRules.js";
import { findOrganizationById } from "../db/repos/organizations.js";
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
        | "message_size_limit";
      limit?: number;
      used?: number;
    };

const PAST_DUE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

export function getEffectivePlan(
  organization: Pick<Organization, "planCode" | "subscriptionStatus" | "currentPeriodEnd">,
): PlanDefinition {
  if (organization.planCode === "free") return getPlanDefinition("free");

  if (organization.planCode === "business") return getPlanDefinition("business");

  switch (organization.subscriptionStatus) {
    case "trialing":
    case "active":
      return getPlanDefinition(organization.planCode as PlanCode);
    case "past_due":
      if (
        organization.currentPeriodEnd &&
        Date.now() - organization.currentPeriodEnd.getTime() <= PAST_DUE_GRACE_MS
      ) {
        return getPlanDefinition(organization.planCode as PlanCode);
      }
      return getPlanDefinition("free");
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

function shouldEnforceHostedLimits(): boolean {
  return loadConfig().appMode === "hosted";
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
