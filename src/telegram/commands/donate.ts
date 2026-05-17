import { InlineKeyboard, type Context } from "grammy";
import { loadConfig } from "../../config.js";
import { getDb } from "../../db/client.js";
import { getMessages, resolveLocale } from "../../i18n/index.js";

export async function donateHandler(ctx: Context): Promise<void> {
  const config = loadConfig();
  const locale = await resolveDonateLocale(ctx);
  const messages = getMessages(locale);

  if (!config.donationUrl) {
    await ctx.reply(messages.donate.unavailable);
    return;
  }

  const keyboard = new InlineKeyboard().url(messages.donate.button, config.donationUrl);
  await ctx.reply(`<b>${messages.donate.title}</b>\n\n${messages.donate.body}`, {
    parse_mode: "HTML",
    reply_markup: keyboard,
  });
}

async function resolveDonateLocale(ctx: Context) {
  try {
    return await resolveLocale(ctx, getDb());
  } catch {
    return resolveLocale(ctx);
  }
}
