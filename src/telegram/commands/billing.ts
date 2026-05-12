import { InlineKeyboard, type Context } from "grammy";
import { loadConfig } from "../../config.js";
import { getDb } from "../../db/client.js";
import { getEffectivePlan } from "../../billing/limits.js";
import { buildBillingStatusText } from "../../billing/usageSummary.js";
import {
  getBillingOrganizationForUser,
  getPrimaryOrganizationForUser,
} from "../../tenant/currentOrganization.js";
import { countActiveAliasesByOrganization } from "../../db/repos/aliases.js";
import { getOrganizationStorageUsage } from "../../db/repos/storageUsage.js";
import { getOrganizationUsageMonth, usageMonthForDate } from "../../db/repos/usage.js";
import { getLogger } from "../../utils/logger.js";
import { CB_BILLING_UPGRADE, CB_BILLING_PORTAL } from "../callbacks.js";
import { canUseSelfServeBilling } from "../../billing/selfServe.js";
import { getMessages, resolveLocale } from "../../i18n/index.js";

export async function billingHandler(ctx: Context): Promise<void> {
  if (!ctx.from) return;

  const db = getDb();
  const locale = await resolveLocale(ctx, db);
  const messages = getMessages(locale);
  const config = loadConfig();
  if (config.appMode !== "hosted") {
    await ctx.reply(messages.billingCommands.billingSelfHosted);
    return;
  }

  try {
    const organization = await getPrimaryOrganizationForUser(db, BigInt(ctx.from.id));
    if (!organization) {
      await ctx.reply(messages.common.noHostedWorkspace);
      return;
    }
    const billingOrganization = await getBillingOrganizationForUser(db, BigInt(ctx.from.id));

    const plan = getEffectivePlan(organization);
    const month = usageMonthForDate();

    const [usage, storage, aliasesUsed] = await Promise.all([
      getOrganizationUsageMonth(db, organization.id, month),
      getOrganizationStorageUsage(db, organization.id),
      countActiveAliasesByOrganization(db, organization.id),
    ]);

    const storageBytes = (storage?.rawEmailBytes ?? 0n) + (storage?.attachmentBytes ?? 0n);

    const text = buildBillingStatusText(
      {
        plan,
        organization,
        month,
        acceptedBillable: usage?.deliveredCount ?? 0,
        egressBytes: usage?.egressBytes ?? 0n,
        storageBytes,
        aliasesUsed,
      },
      locale,
    );

    if (!billingOrganization) {
      await ctx.reply(text, { parse_mode: "HTML" });
      return;
    }

    if (!canUseSelfServeBilling(config, billingOrganization)) {
      await ctx.reply(`${text}\n\n${messages.billingCommands.manualBilling}`, {
        parse_mode: "HTML",
      });
      return;
    }

    const keyboard = new InlineKeyboard()
      .text(messages.billingCommands.upgradeButton, CB_BILLING_UPGRADE)
      .text(messages.billingCommands.manageBillingButton, CB_BILLING_PORTAL);

    await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
  } catch (err: unknown) {
    getLogger().error({ err }, "billingHandler: failed to fetch billing data");
    await ctx.reply(messages.billingCommands.billingUnavailable);
  }
}
