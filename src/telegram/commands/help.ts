import type { Context } from "grammy";
import { settingsHelpText, safetyDisclaimerText } from "../renderModeGuidance.js";
import { loadConfig } from "../../config.js";
import { isSelfServeBillingEnabled } from "../../billing/selfServe.js";
import { getDb } from "../../db/client.js";
import { getMessages, resolveLocale } from "../../i18n/index.js";

export async function helpHandler(ctx: Context): Promise<void> {
  const config = loadConfig();
  const locale = await resolveHelpLocale(ctx);
  const messages = getMessages(locale);
  const billingHelp = isSelfServeBillingEnabled(config) ? messages.help.billingStripe : "";
  const billingSection = billingHelp ? `\n${billingHelp}\n` : "";

  const body = messages.help.text(
    billingSection,
    settingsHelpText(locale),
    safetyDisclaimerText(locale),
  );
  await ctx.reply(`${body}\n\n${messages.common.languageHint}`, {
    parse_mode: "HTML",
  });
}

async function resolveHelpLocale(ctx: Context) {
  try {
    return await resolveLocale(ctx, getDb());
  } catch {
    return resolveLocale(ctx);
  }
}
