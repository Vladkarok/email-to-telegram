import type { Context } from "grammy";
import { settingsHelpText, safetyDisclaimerText } from "../renderModeGuidance.js";
import { loadConfig } from "../../config.js";
import { isSelfServeBillingEnabled, resolveSupportContact } from "../../billing/selfServe.js";
import { getDb } from "../../db/client.js";
import { getMessages, resolveLocale, type Messages } from "../../i18n/index.js";
import { escapeHtml } from "../../utils/html.js";

export async function helpHandler(ctx: Context): Promise<void> {
  const config = loadConfig();
  const locale = await resolveHelpLocale(ctx);
  const messages = getMessages(locale);
  const billingHelp = billingHelpSection(config, messages);
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

/**
 * Stripe self-serve lists the purchase commands. Donation mode sells nothing,
 * so it lists plan/usage commands and names the operator for higher limits,
 * the same line the quota notices use. Anything else shows no billing section.
 */
function billingHelpSection(config: ReturnType<typeof loadConfig>, messages: Messages): string {
  if (isSelfServeBillingEnabled(config)) return messages.help.billingStripe;
  if (config.appMode === "hosted" && config.billingProvider === "donation") {
    const contact = escapeHtml(resolveSupportContact(config));
    return `${messages.help.billingManual}\n${messages.quotaNotice.higherLimitsContact(contact)}`;
  }
  return "";
}

async function resolveHelpLocale(ctx: Context) {
  try {
    return await resolveLocale(ctx, getDb());
  } catch {
    return resolveLocale(ctx);
  }
}
