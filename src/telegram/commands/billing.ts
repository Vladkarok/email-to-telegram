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
import { canUseSelfServeBilling, MANUAL_BILLING_MESSAGE } from "../../billing/selfServe.js";

const SELF_HOSTED_MESSAGE =
  "ℹ️ Billing is not enabled in self-hosted mode. /billing is only available on the hosted service.";

const NO_ORGANIZATION_MESSAGE =
  "❌ No hosted workspace found for your account. Use /start to set one up.";

export async function billingHandler(ctx: Context): Promise<void> {
  if (!ctx.from) return;

  const config = loadConfig();
  if (config.appMode !== "hosted") {
    await ctx.reply(SELF_HOSTED_MESSAGE);
    return;
  }

  const db = getDb();

  try {
    const organization = await getPrimaryOrganizationForUser(db, BigInt(ctx.from.id));
    if (!organization) {
      await ctx.reply(NO_ORGANIZATION_MESSAGE);
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

    const text = buildBillingStatusText({
      plan,
      organization,
      month,
      acceptedBillable: usage?.deliveredCount ?? 0,
      egressBytes: usage?.egressBytes ?? 0n,
      storageBytes,
      aliasesUsed,
    });

    if (!billingOrganization) {
      await ctx.reply(text, { parse_mode: "HTML" });
      return;
    }

    if (!canUseSelfServeBilling(config, billingOrganization)) {
      await ctx.reply(`${text}\n\n${MANUAL_BILLING_MESSAGE}`, { parse_mode: "HTML" });
      return;
    }

    const keyboard = new InlineKeyboard()
      .text("⬆️ Upgrade", CB_BILLING_UPGRADE)
      .text("🧾 Manage Billing", CB_BILLING_PORTAL);

    await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
  } catch (err: unknown) {
    getLogger().error({ err }, "billingHandler: failed to fetch billing data");
    await ctx.reply("❌ Billing data is temporarily unavailable. Please try again shortly.");
  }
}
