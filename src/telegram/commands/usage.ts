import type { Context } from "grammy";
import { loadConfig } from "../../config.js";
import { getDb } from "../../db/client.js";
import { getEffectivePlan } from "../../billing/limits.js";
import { buildUsageSummaryText } from "../../billing/usageSummary.js";
import { getPrimaryOrganizationForUser } from "../../tenant/currentOrganization.js";
import { countActiveAliasesByOrganization } from "../../db/repos/aliases.js";
import { countAllowRulesByOrganization } from "../../db/repos/allowRules.js";
import { countDeliveryLogsByOrgInMonth } from "../../db/repos/deliveryLogs.js";
import { getOrganizationStorageUsage } from "../../db/repos/storageUsage.js";
import { getOrganizationUsageMonth, usageMonthForDate } from "../../db/repos/usage.js";

const SELF_HOSTED_MESSAGE =
  "ℹ️ Billing is not enabled in self-hosted mode. /usage is only available on the hosted service.";

const NO_ORGANIZATION_MESSAGE =
  "❌ No hosted workspace found for your account. Use /start to set one up.";

export async function usageHandler(ctx: Context): Promise<void> {
  if (!ctx.from) return;

  if (loadConfig().appMode !== "hosted") {
    await ctx.reply(SELF_HOSTED_MESSAGE);
    return;
  }

  const db = getDb();
  const organization = await getPrimaryOrganizationForUser(db, BigInt(ctx.from.id));
  if (!organization) {
    await ctx.reply(NO_ORGANIZATION_MESSAGE);
    return;
  }

  const plan = getEffectivePlan(organization);
  const month = usageMonthForDate();

  const [usage, storage, aliasesUsed, allowRulesUsed, telegramDelivered, telegramFailed] =
    await Promise.all([
      getOrganizationUsageMonth(db, organization.id, month),
      getOrganizationStorageUsage(db, organization.id),
      countActiveAliasesByOrganization(db, organization.id),
      countAllowRulesByOrganization(db, organization.id),
      countDeliveryLogsByOrgInMonth(db, organization.id, month, ["delivered"]),
      countDeliveryLogsByOrgInMonth(db, organization.id, month, ["failed"]),
    ]);

  const storageBytes = (storage?.rawEmailBytes ?? 0n) + (storage?.attachmentBytes ?? 0n);

  const text = buildUsageSummaryText({
    plan,
    month,
    counters: {
      acceptedBillable: usage?.deliveredCount ?? 0,
      rejected: usage?.rejectedCount ?? 0,
      telegramDelivered,
      telegramFailed,
    },
    egressBytes: usage?.egressBytes ?? 0n,
    storageBytes,
    aliasesUsed,
    allowRulesUsed,
  });

  await ctx.reply(text, { parse_mode: "HTML" });
}
