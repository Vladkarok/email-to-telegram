import { InlineKeyboard, type Context, type CallbackQueryContext } from "grammy";
import { loadConfig } from "../../config.js";
import { getDb } from "../../db/client.js";
import { findUserById } from "../../db/repos/users.js";
import { createCheckoutSession, BillingCheckoutConflictError } from "../../billing/checkout.js";
import { isStripePriceKey } from "../../billing/stripe.js";
import { getLogger } from "../../utils/logger.js";
import { escapeHtml } from "../../utils/html.js";
import { CB_UPGRADE_PLAN } from "../callbacks.js";
import {
  isManualBillingUser,
  isSelfServeBillingEnabled,
  manualBillingAlert,
  manualBillingMessage,
} from "../../billing/selfServe.js";
import { DEFAULT_LOCALE, getMessages, resolveLocale, type Locale } from "../../i18n/index.js";

/** Builds the plan selection inline keyboard shown by /upgrade and bill:upgrade. */
export function buildUpgradePlanKeyboard(locale: Locale = DEFAULT_LOCALE): InlineKeyboard {
  const labels = getMessages(locale).upgrade.planLabels;
  return new InlineKeyboard()
    .text(labels.personal_monthly, CB_UPGRADE_PLAN.build("personal_monthly"))
    .text(labels.personal_yearly, CB_UPGRADE_PLAN.build("personal_yearly"))
    .row()
    .text(labels.pro_monthly, CB_UPGRADE_PLAN.build("pro_monthly"))
    .text(labels.pro_yearly, CB_UPGRADE_PLAN.build("pro_yearly"))
    .row()
    .text(labels.team_monthly, CB_UPGRADE_PLAN.build("team_monthly"))
    .text(labels.team_yearly, CB_UPGRADE_PLAN.build("team_yearly"));
}

/** /upgrade command handler — shows plan selection keyboard. */
export async function upgradeHandler(ctx: Context): Promise<void> {
  if (!ctx.from) return;
  const locale = await resolveLocale(ctx, getDb());
  const messages = getMessages(locale);

  const config = loadConfig();
  if (config.appMode !== "hosted") {
    await ctx.reply(messages.upgrade.selfHosted);
    return;
  }
  if (!isSelfServeBillingEnabled(config)) {
    await ctx.reply(manualBillingMessage(config, messages));
    return;
  }

  try {
    const db = getDb();
    const user = await findUserById(db, BigInt(ctx.from.id));
    if (!user) {
      await ctx.reply(messages.upgrade.forbidden);
      return;
    }
    if (isManualBillingUser(user)) {
      await ctx.reply(manualBillingMessage(config, messages));
      return;
    }

    await ctx.reply(messages.upgrade.header, {
      parse_mode: "HTML",
      reply_markup: buildUpgradePlanKeyboard(locale),
    });
  } catch (err: unknown) {
    getLogger().error({ err }, "upgradeHandler: failed");
    await ctx.reply(messages.upgrade.loadFailed);
  }
}

/**
 * Callback handler for the bill:upgrade button on /billing.
 * Shows the same plan selection keyboard as /upgrade.
 */
export async function upgradeCallbackHandler(ctx: CallbackQueryContext<Context>): Promise<void> {
  if (!ctx.from) return;
  const locale = await resolveLocale(ctx, getDb());
  const messages = getMessages(locale);

  const config = loadConfig();
  if (config.appMode !== "hosted") {
    await ctx.answerCallbackQuery({ text: messages.upgrade.selfHosted, show_alert: true });
    return;
  }
  if (!isSelfServeBillingEnabled(config)) {
    await ctx.answerCallbackQuery();
    await ctx.reply(manualBillingMessage(config, messages));
    return;
  }

  try {
    const db = getDb();
    const user = await findUserById(db, BigInt(ctx.from.id));
    if (!user) {
      await ctx.answerCallbackQuery({ text: messages.upgrade.forbidden, show_alert: true });
      return;
    }
    if (isManualBillingUser(user)) {
      await ctx.answerCallbackQuery();
      await ctx.reply(manualBillingMessage(config, messages));
      return;
    }

    await ctx.answerCallbackQuery();
    await ctx.reply(messages.upgrade.header, {
      parse_mode: "HTML",
      reply_markup: buildUpgradePlanKeyboard(locale),
    });
  } catch (err: unknown) {
    getLogger().error({ err }, "upgradeCallbackHandler: failed");
    await ctx.answerCallbackQuery({
      text: messages.upgrade.loadFailed,
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
  const messages = getMessages(await resolveLocale(ctx, getDb()));

  const config = loadConfig();
  if (config.appMode !== "hosted") {
    await ctx.answerCallbackQuery({ text: messages.upgrade.selfHosted, show_alert: true });
    return;
  }
  if (!isSelfServeBillingEnabled(config)) {
    await ctx.answerCallbackQuery({
      text: manualBillingAlert(messages),
      show_alert: true,
    });
    return;
  }

  const priceKey = (ctx.match as RegExpMatchArray | null)?.[1];
  if (!priceKey || !isStripePriceKey(priceKey)) {
    await ctx.answerCallbackQuery({ text: messages.upgrade.invalidPlan, show_alert: true });
    return;
  }

  try {
    const db = getDb();
    const user = await findUserById(db, BigInt(ctx.from.id));
    if (!user) {
      await ctx.answerCallbackQuery({ text: messages.upgrade.forbidden, show_alert: true });
      return;
    }
    if (isManualBillingUser(user)) {
      await ctx.answerCallbackQuery({
        text: manualBillingAlert(messages),
        show_alert: true,
      });
      return;
    }

    const url = await createCheckoutSession(db, user.id, priceKey);
    const label = messages.upgrade.planLabels[priceKey];

    await ctx.answerCallbackQuery();
    const keyboard = new InlineKeyboard().url(messages.upgrade.completeButton, url);
    await ctx.reply(messages.upgrade.checkoutText(escapeHtml(label)), {
      parse_mode: "HTML",
      reply_markup: keyboard,
    });
  } catch (err: unknown) {
    if (err instanceof BillingCheckoutConflictError) {
      await ctx.answerCallbackQuery({
        text: messages.upgrade.activeSubscriptionConflict,
        show_alert: true,
      });
      return;
    }
    getLogger().error({ err }, "upgradePlanCallbackHandler: failed to create checkout session");
    await ctx.answerCallbackQuery({
      text: messages.upgrade.checkoutFailed,
      show_alert: true,
    });
  }
}
