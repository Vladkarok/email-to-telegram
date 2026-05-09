import { InlineKeyboard, type Context, type CallbackQueryContext } from "grammy";
import { loadConfig } from "../../config.js";
import { getDb } from "../../db/client.js";
import { getBillingOrganizationForUser } from "../../tenant/currentOrganization.js";
import { createCheckoutSession, BillingCheckoutConflictError } from "../../billing/checkout.js";
import { isStripePriceKey, type StripePriceKey } from "../../billing/stripe.js";
import { getLogger } from "../../utils/logger.js";
import { escapeHtml } from "../../utils/html.js";
import { CB_UPGRADE_PLAN } from "../callbacks.js";
import {
  canUseSelfServeBilling,
  isSelfServeBillingEnabled,
  MANUAL_BILLING_MESSAGE,
} from "../../billing/selfServe.js";

const SELF_HOSTED_MESSAGE =
  "ℹ️ Billing is not enabled in self-hosted mode. /upgrade is only available on the hosted service.";

const BILLING_FORBIDDEN_MESSAGE = "❌ Billing changes require workspace owner or admin access.";

const PLAN_LABELS: Record<StripePriceKey, string> = {
  personal_monthly: "Personal — Monthly",
  personal_yearly: "Personal — Yearly",
  pro_monthly: "Pro — Monthly",
  pro_yearly: "Pro — Yearly",
  team_monthly: "Team — Monthly",
  team_yearly: "Team — Yearly",
};

/** Builds the plan selection inline keyboard shown by /upgrade and bill:upgrade. */
export function buildUpgradePlanKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("Personal — Monthly", CB_UPGRADE_PLAN.build("personal_monthly"))
    .text("Personal — Yearly", CB_UPGRADE_PLAN.build("personal_yearly"))
    .row()
    .text("Pro — Monthly", CB_UPGRADE_PLAN.build("pro_monthly"))
    .text("Pro — Yearly", CB_UPGRADE_PLAN.build("pro_yearly"))
    .row()
    .text("Team — Monthly", CB_UPGRADE_PLAN.build("team_monthly"))
    .text("Team — Yearly", CB_UPGRADE_PLAN.build("team_yearly"));
}

/** /upgrade command handler — shows plan selection keyboard. */
export async function upgradeHandler(ctx: Context): Promise<void> {
  if (!ctx.from) return;

  const config = loadConfig();
  if (config.appMode !== "hosted") {
    await ctx.reply(SELF_HOSTED_MESSAGE);
    return;
  }
  if (!isSelfServeBillingEnabled(config)) {
    await ctx.reply(MANUAL_BILLING_MESSAGE);
    return;
  }

  try {
    const db = getDb();
    const organization = await getBillingOrganizationForUser(db, BigInt(ctx.from.id));
    if (!organization) {
      await ctx.reply(BILLING_FORBIDDEN_MESSAGE);
      return;
    }
    if (!canUseSelfServeBilling(config, organization)) {
      await ctx.reply(MANUAL_BILLING_MESSAGE);
      return;
    }

    await ctx.reply("<b>⬆️ Upgrade your plan</b>\n\nSelect a plan to start your upgrade:", {
      parse_mode: "HTML",
      reply_markup: buildUpgradePlanKeyboard(),
    });
  } catch (err: unknown) {
    getLogger().error({ err }, "upgradeHandler: failed");
    await ctx.reply("❌ Unable to load upgrade options. Please try again shortly.");
  }
}

/**
 * Callback handler for the bill:upgrade button on /billing.
 * Shows the same plan selection keyboard as /upgrade.
 */
export async function upgradeCallbackHandler(ctx: CallbackQueryContext<Context>): Promise<void> {
  if (!ctx.from) return;

  const config = loadConfig();
  if (config.appMode !== "hosted") {
    await ctx.answerCallbackQuery({ text: SELF_HOSTED_MESSAGE, show_alert: true });
    return;
  }
  if (!isSelfServeBillingEnabled(config)) {
    await ctx.answerCallbackQuery();
    await ctx.reply(MANUAL_BILLING_MESSAGE);
    return;
  }

  try {
    const db = getDb();
    const organization = await getBillingOrganizationForUser(db, BigInt(ctx.from.id));
    if (!organization) {
      await ctx.answerCallbackQuery({ text: BILLING_FORBIDDEN_MESSAGE, show_alert: true });
      return;
    }
    if (!canUseSelfServeBilling(config, organization)) {
      await ctx.answerCallbackQuery();
      await ctx.reply(MANUAL_BILLING_MESSAGE);
      return;
    }

    await ctx.answerCallbackQuery();
    await ctx.reply("<b>⬆️ Upgrade your plan</b>\n\nSelect a plan to start your upgrade:", {
      parse_mode: "HTML",
      reply_markup: buildUpgradePlanKeyboard(),
    });
  } catch (err: unknown) {
    getLogger().error({ err }, "upgradeCallbackHandler: failed");
    await ctx.answerCallbackQuery({
      text: "❌ Unable to load upgrade options. Please try again shortly.",
      show_alert: true,
    });
  }
}

/**
 * Callback handler for upg:{priceKey} buttons — creates a Stripe Checkout Session
 * for the selected plan and replies with a one-time checkout URL button.
 */
export async function upgradePlanCallbackHandler(
  ctx: CallbackQueryContext<Context>,
): Promise<void> {
  if (!ctx.from) return;

  const config = loadConfig();
  if (config.appMode !== "hosted") {
    await ctx.answerCallbackQuery({ text: SELF_HOSTED_MESSAGE, show_alert: true });
    return;
  }
  if (!isSelfServeBillingEnabled(config)) {
    await ctx.answerCallbackQuery({
      text: "Self-serve payments are temporarily unavailable.",
      show_alert: true,
    });
    return;
  }

  const priceKey = (ctx.match as RegExpMatchArray | null)?.[1];
  if (!priceKey || !isStripePriceKey(priceKey)) {
    await ctx.answerCallbackQuery({ text: "❌ Invalid plan selection.", show_alert: true });
    return;
  }

  try {
    const db = getDb();
    const organization = await getBillingOrganizationForUser(db, BigInt(ctx.from.id));
    if (!organization) {
      await ctx.answerCallbackQuery({ text: BILLING_FORBIDDEN_MESSAGE, show_alert: true });
      return;
    }
    if (!canUseSelfServeBilling(config, organization)) {
      await ctx.answerCallbackQuery({
        text: "Self-serve payments are temporarily unavailable for this workspace.",
        show_alert: true,
      });
      return;
    }

    const url = await createCheckoutSession(db, organization.id, priceKey);
    const label = PLAN_LABELS[priceKey];

    await ctx.answerCallbackQuery();
    const keyboard = new InlineKeyboard().url("Complete Checkout →", url);
    await ctx.reply(
      `<b>⬆️ ${escapeHtml(label)}</b>\n\nTap the button below to complete your upgrade. This link expires in 30 minutes.`,
      { parse_mode: "HTML", reply_markup: keyboard },
    );
  } catch (err: unknown) {
    if (err instanceof BillingCheckoutConflictError) {
      await ctx.answerCallbackQuery({
        text: "You already have an active subscription. Use /portal to manage it.",
        show_alert: true,
      });
      return;
    }
    getLogger().error({ err }, "upgradePlanCallbackHandler: failed to create checkout session");
    await ctx.answerCallbackQuery({
      text: "❌ Unable to create checkout session. Please try again shortly.",
      show_alert: true,
    });
  }
}
