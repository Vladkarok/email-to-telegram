import { InlineKeyboard, type CallbackQueryContext, type Context } from "grammy";
import { getDb } from "../../db/client.js";
import {
  LocaleColumnUnavailableError,
  isLocaleColumnUnavailableError,
  updateUserLocale,
} from "../../db/repos/users.js";
import {
  DEFAULT_LOCALE,
  getMessages,
  isLocale,
  resolveLocale,
  type Locale,
} from "../../i18n/index.js";
import { CB_LANGUAGE_CLOSE, CB_LANGUAGE_SET } from "../callbacks.js";

export async function languageHandler(ctx: Context): Promise<void> {
  if (!ctx.from) return;
  const db = getDb();
  const locale = await resolveLocale(ctx, db);
  const messages = getMessages(locale);
  await ctx.reply(buildLanguageText(locale), {
    parse_mode: "HTML",
    reply_markup: buildLanguageKeyboard(locale, messages),
  });
}

export async function languageCallbackHandler(ctx: CallbackQueryContext<Context>): Promise<void> {
  if (!ctx.from) return;

  const locale = String(ctx.match[1]);
  if (!isLocale(locale)) {
    const fallback = getMessages(DEFAULT_LOCALE);
    await ctx.answerCallbackQuery(fallback.language.invalidLanguage);
    return;
  }

  const db = getDb();
  const messages = getMessages(locale);
  try {
    await updateUserLocale(db, BigInt(ctx.from.id), locale);
  } catch (err: unknown) {
    if (err instanceof LocaleColumnUnavailableError || isLocaleColumnUnavailableError(err)) {
      await ctx.answerCallbackQuery(messages.language.unavailable);
      return;
    }
    throw err;
  }

  await ctx.answerCallbackQuery(messages.language.saved(messages.localeName));
  await ctx.editMessageText(buildLanguageText(locale), {
    parse_mode: "HTML",
    reply_markup: buildLanguageKeyboard(locale, messages),
  });
}

export async function languageCloseCallbackHandler(
  ctx: CallbackQueryContext<Context>,
): Promise<void> {
  await ctx.answerCallbackQuery();
  await ctx.deleteMessage().catch(() => {});
}

function buildLanguageText(locale: Locale): string {
  const messages = getMessages(locale);
  return `${messages.language.choose}\n\n${messages.language.current(messages.localeName)}`;
}

function buildLanguageKeyboard(
  locale: Locale,
  messages = getMessages(DEFAULT_LOCALE),
): InlineKeyboard {
  return new InlineKeyboard()
    .text(label(locale, "en", messages.language.buttonEnglish), CB_LANGUAGE_SET.build("en"))
    .text(label(locale, "uk", messages.language.buttonUkrainian), CB_LANGUAGE_SET.build("uk"))
    .row()
    .text(label(locale, "fr", messages.language.buttonFrench), CB_LANGUAGE_SET.build("fr"))
    .text(label(locale, "it", messages.language.buttonItalian), CB_LANGUAGE_SET.build("it"))
    .row()
    .text(messages.language.closeButton, CB_LANGUAGE_CLOSE);
}

function label(current: Locale, candidate: Locale, text: string): string {
  return current === candidate ? `✓ ${text}` : text;
}
