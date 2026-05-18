import type { Context } from "grammy";
import { loadConfig } from "../../config.js";
import { getDb } from "../../db/client.js";
import { getMessages, resolveLocale } from "../../i18n/index.js";

export async function privacyHandler(ctx: Context): Promise<void> {
  const config = loadConfig();
  const locale = await resolvePrivacyLocale(ctx);
  const messages = getMessages(locale);

  const body = messages.privacy.text(
    config.supportContact ?? null,
    config.privacyPolicyUrl ?? null,
  );
  await ctx.reply(`${body}\n\n${messages.common.languageHint}`, {
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  });
}

async function resolvePrivacyLocale(ctx: Context) {
  try {
    return await resolveLocale(ctx, getDb());
  } catch {
    return resolveLocale(ctx);
  }
}
