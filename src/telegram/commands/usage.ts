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
import { getLogger } from "../../utils/logger.js";
import { getMessages, resolveLocale } from "../../i18n/index.js";

export async function usageHandler(ctx: Context): Promise<void> {
  if (!ctx.from) return;
  const db = getDb();
  const locale = await resolveLocale(ctx, db);
  const messages = getMessages(locale);

  if (loadConfig().appMode !== "hosted") {
    await ctx.reply(messages.billingCommands.usageSelfHosted);
    return;
  }

  try {
    const organization = await getPrimaryOrganizationForUser(db, BigInt(ctx.from.id));
    if (!organization) {
      await ctx.reply(messages.common.noHostedWorkspace);
      return;
    }

    const plan = getEffectivePlan(organization);
    const month = usageMonthForDate();

    const [
      usage,
      storage,
      aliasesUsed,
      allowRulesUsed,
      telegramDelivered,
      telegramFailed,
      telegramPending,
    ] = await Promise.all([
      getOrganizationUsageMonth(db, organization.id, month),
      getOrganizationStorageUsage(db, organization.id),
      countActiveAliasesByOrganization(db, organization.id),
      countAllowRulesByOrganization(db, organization.id),
      countDeliveryLogsByOrgInMonth(db, organization.id, month, ["delivered"]),
      countDeliveryLogsByOrgInMonth(db, organization.id, month, ["failed"]),
      countDeliveryLogsByOrgInMonth(db, organization.id, month, [
        "received",
        "processing",
        "retrying",
      ]),
    ]);

    const storageBytes = (storage?.rawEmailBytes ?? 0n) + (storage?.attachmentBytes ?? 0n);

    const text = buildUsageSummaryText(
      {
        plan,
        month,
        counters: {
          acceptedBillable: usage?.deliveredCount ?? 0,
          rejected: usage?.rejectedCount ?? 0,
          telegramDelivered,
          telegramFailed,
          telegramPending,
        },
        egressBytes: usage?.egressBytes ?? 0n,
        storageBytes,
        aliasesUsed,
        allowRulesUsed,
      },
      locale,
    );

    await ctx.reply(text, { parse_mode: "HTML" });
  } catch (err: unknown) {
    getLogger().error({ err }, "usageHandler: failed to fetch usage data");
    await ctx.reply(messages.billingCommands.usageUnavailable);
  }
}
