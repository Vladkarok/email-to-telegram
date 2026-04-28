import { InlineKeyboard, type Context, type CallbackQueryContext } from "grammy";
import { loadConfig } from "../../config.js";
import { getDb } from "../../db/client.js";
import { getPrimaryOrganizationForUser } from "../../tenant/currentOrganization.js";
import { createCustomerPortalSession } from "../../billing/customerPortal.js";
import { buildUpgradePlanKeyboard } from "./upgrade.js";
import { getLogger } from "../../utils/logger.js";

const SELF_HOSTED_MESSAGE =
  "ℹ️ Billing is not enabled in self-hosted mode. /portal is only available on the hosted service.";

const NO_ORGANIZATION_MESSAGE =
  "❌ No hosted workspace found for your account. Use /start to set one up.";

const NO_CUSTOMER_TEXT =
  "ℹ️ You don't have an active billing account yet.\n\nUse /upgrade to choose a plan and start a subscription.\n\n<b>Choose a plan:</b>";

const PORTAL_TEXT =
  "<b>🧾 Billing Portal</b>\n\nTap below to manage your subscription, view invoices, or update payment details. This link expires in 5 minutes.";

/** /portal command handler — opens Stripe Customer Portal or shows upgrade options. */
export async function portalHandler(ctx: Context): Promise<void> {
  if (!ctx.from) return;

  if (loadConfig().appMode !== "hosted") {
    await ctx.reply(SELF_HOSTED_MESSAGE);
    return;
  }

  try {
    const db = getDb();
    const organization = await getPrimaryOrganizationForUser(db, BigInt(ctx.from.id));
    if (!organization) {
      await ctx.reply(NO_ORGANIZATION_MESSAGE);
      return;
    }

    const url = await createCustomerPortalSession(db, organization.id);
    if (!url) {
      await ctx.reply(NO_CUSTOMER_TEXT, {
        parse_mode: "HTML",
        reply_markup: buildUpgradePlanKeyboard(),
      });
      return;
    }

    const keyboard = new InlineKeyboard().url("Open Billing Portal →", url);
    await ctx.reply(PORTAL_TEXT, { parse_mode: "HTML", reply_markup: keyboard });
  } catch (err: unknown) {
    getLogger().error({ err }, "portalHandler: failed");
    await ctx.reply("❌ Unable to open the billing portal. Please try again shortly.");
  }
}

/**
 * Callback handler for the bill:portal button on /billing.
 * Opens Stripe Customer Portal or shows upgrade options if no billing account exists.
 */
export async function portalCallbackHandler(ctx: CallbackQueryContext<Context>): Promise<void> {
  if (!ctx.from) return;

  if (loadConfig().appMode !== "hosted") {
    await ctx.answerCallbackQuery({ text: SELF_HOSTED_MESSAGE, show_alert: true });
    return;
  }

  try {
    const db = getDb();
    const organization = await getPrimaryOrganizationForUser(db, BigInt(ctx.from.id));
    if (!organization) {
      await ctx.answerCallbackQuery({ text: NO_ORGANIZATION_MESSAGE, show_alert: true });
      return;
    }

    const url = await createCustomerPortalSession(db, organization.id);
    if (!url) {
      await ctx.answerCallbackQuery();
      await ctx.reply(NO_CUSTOMER_TEXT, {
        parse_mode: "HTML",
        reply_markup: buildUpgradePlanKeyboard(),
      });
      return;
    }

    await ctx.answerCallbackQuery();
    const keyboard = new InlineKeyboard().url("Open Billing Portal →", url);
    await ctx.reply(PORTAL_TEXT, { parse_mode: "HTML", reply_markup: keyboard });
  } catch (err: unknown) {
    getLogger().error({ err }, "portalCallbackHandler: failed");
    await ctx.answerCallbackQuery({
      text: "❌ Unable to open the billing portal. Please try again shortly.",
      show_alert: true,
    });
  }
}
