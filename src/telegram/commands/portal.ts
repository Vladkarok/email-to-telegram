import { InlineKeyboard, type Context, type CallbackQueryContext } from "grammy";
import { loadConfig } from "../../config.js";
import { getDb } from "../../db/client.js";
import { findUserById } from "../../db/repos/users.js";
import { createCustomerPortalSession } from "../../billing/customerPortal.js";
import { buildUpgradePlanKeyboard } from "./upgrade.js";
import { getLogger } from "../../utils/logger.js";
import { canUseSelfServeBilling, manualBillingMessage } from "../../billing/selfServe.js";
import { getMessages, resolveLocale } from "../../i18n/index.js";

/** /portal command handler — opens Stripe Customer Portal or shows upgrade options. */
export async function portalHandler(ctx: Context): Promise<void> {
  if (!ctx.from) return;
  const locale = await resolveLocale(ctx, getDb());
  const messages = getMessages(locale);

  const config = loadConfig();
  if (config.appMode !== "hosted") {
    await ctx.reply(messages.portal.selfHosted);
    return;
  }

  try {
    const db = getDb();
    const userId = BigInt(ctx.from.id);
    const user = await findUserById(db, userId);
    if (!user) {
      await ctx.reply(messages.portal.forbidden);
      return;
    }

    if (!canUseSelfServeBilling(config, user)) {
      await ctx.reply(manualBillingMessage(config, messages));
      return;
    }

    const url = await createCustomerPortalSession(db, userId);
    if (!url) {
      await ctx.reply(messages.portal.noCustomer, {
        parse_mode: "HTML",
        reply_markup: buildUpgradePlanKeyboard(locale),
      });
      return;
    }

    const keyboard = new InlineKeyboard().url(messages.portal.openButton, url);
    await ctx.reply(messages.portal.text, { parse_mode: "HTML", reply_markup: keyboard });
  } catch (err: unknown) {
    getLogger().error({ err }, "portalHandler: failed");
    await ctx.reply(messages.portal.unavailable);
  }
}

/**
 * Callback handler for the bill:portal button on /billing.
 * Opens Stripe Customer Portal or shows upgrade options if no billing account exists.
 */
export async function portalCallbackHandler(ctx: CallbackQueryContext<Context>): Promise<void> {
  if (!ctx.from) return;
  const locale = await resolveLocale(ctx, getDb());
  const messages = getMessages(locale);

  const config = loadConfig();
  if (config.appMode !== "hosted") {
    await ctx.answerCallbackQuery({ text: messages.portal.selfHosted, show_alert: true });
    return;
  }

  try {
    const db = getDb();
    const userId = BigInt(ctx.from.id);
    const user = await findUserById(db, userId);
    if (!user) {
      await ctx.answerCallbackQuery({ text: messages.portal.forbidden, show_alert: true });
      return;
    }

    if (!canUseSelfServeBilling(config, user)) {
      await ctx.answerCallbackQuery();
      await ctx.reply(manualBillingMessage(config, messages));
      return;
    }

    const url = await createCustomerPortalSession(db, userId);
    if (!url) {
      await ctx.answerCallbackQuery();
      await ctx.reply(messages.portal.noCustomer, {
        parse_mode: "HTML",
        reply_markup: buildUpgradePlanKeyboard(locale),
      });
      return;
    }

    await ctx.answerCallbackQuery();
    const keyboard = new InlineKeyboard().url(messages.portal.openButton, url);
    await ctx.reply(messages.portal.text, { parse_mode: "HTML", reply_markup: keyboard });
  } catch (err: unknown) {
    getLogger().error({ err }, "portalCallbackHandler: failed");
    await ctx.answerCallbackQuery({
      text: messages.portal.unavailable,
      show_alert: true,
    });
  }
}
