import { InlineKeyboard } from "grammy";
import type { Context } from "grammy";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../../db/schema.js";
import { loadConfig } from "../../config.js";
import { getAccessibleChats } from "../authorization.js";
import { findUserById } from "../../db/repos/users.js";
import { getEffectivePlan } from "../../billing/limits.js";
import { countActiveAliasesByUser } from "../../db/repos/aliases.js";
import { escapeHtml } from "../../utils/html.js";
import {
  CB_CHAT_SELECTION,
  CB_CHAT_MENU,
  CB_NEW_EMAIL,
  CB_ALIAS_LIST,
  CB_MENU_CLOSE,
} from "../callbacks.js";
import { getMessages, resolveLocale, type Locale } from "../../i18n/index.js";

type Db = NodePgDatabase<typeof schema>;

function chatIcon(type: string): string {
  return type === "private" ? "🏠" : "👥";
}

/**
 * Returns a one-line plan/alias footer for hosted mode,
 * e.g. "Plan: Free | 2/3 aliases used".
 * Returns null in self-hosted mode or when user billing info is unavailable.
 */
async function buildPlanFooter(db: Db, userId: number, locale: Locale): Promise<string | null> {
  if (loadConfig().appMode !== "hosted") return null;

  try {
    const user = await findUserById(db, BigInt(userId));
    if (!user) return null;

    const plan = getEffectivePlan(user);
    const used = await countActiveAliasesByUser(db, user.id);
    return getMessages(locale).chatMenu.planFooter(
      escapeHtml(plan.name),
      used,
      plan.limits.aliases,
    );
  } catch {
    return null;
  }
}

export async function sendChatSelectionMenu(
  ctx: Context,
  db: Db,
  { welcome = false }: { welcome?: boolean } = {},
): Promise<void> {
  if (!ctx.from) return;
  const locale = await resolveLocale(ctx, db);
  const messages = getMessages(locale);
  const chats = await getAccessibleChats(db, ctx.api, ctx.from.id);
  const prefix = welcome ? messages.chatMenu.welcomePrefix : "";

  if (chats.length === 0) {
    await ctx.reply(`${prefix}${messages.chatMenu.noChats}`);
    return;
  }

  const keyboard = new InlineKeyboard();
  for (const chat of chats) {
    keyboard.text(`${chatIcon(chat.type)} ${chat.title}`, CB_CHAT_MENU.build(chat.id)).row();
  }
  keyboard.text(messages.common.closeButton, CB_MENU_CLOSE.build(ctx.from.id));

  const footer = await buildPlanFooter(db, ctx.from.id, locale);
  const body = footer
    ? `${prefix}${messages.chatMenu.selectChat}\n\n<i>${footer}</i>`
    : `${prefix}${messages.chatMenu.selectChat}`;

  await ctx.reply(body, { parse_mode: "HTML", reply_markup: keyboard });
}

export async function editChatSelectionMenu(ctx: Context, db: Db): Promise<void> {
  if (!ctx.from) return;
  const locale = await resolveLocale(ctx, db);
  const messages = getMessages(locale);
  const chats = await getAccessibleChats(db, ctx.api, ctx.from.id);

  if (chats.length === 0) {
    await ctx.editMessageText(messages.chatMenu.noChatsEdit);
    return;
  }

  const keyboard = new InlineKeyboard();
  for (const chat of chats) {
    keyboard.text(`${chatIcon(chat.type)} ${chat.title}`, CB_CHAT_MENU.build(chat.id)).row();
  }
  keyboard.text(messages.common.closeButton, CB_MENU_CLOSE.build(ctx.from.id));

  const footer = await buildPlanFooter(db, ctx.from.id, locale);
  const body = footer
    ? `${messages.chatMenu.selectChat}\n\n<i>${footer}</i>`
    : messages.chatMenu.selectChat;

  await ctx.editMessageText(body, { parse_mode: "HTML", reply_markup: keyboard });
}

export async function editChatManagementMenu(
  ctx: Context,
  db: Db,
  chatId: string,
  chatTitle: string,
): Promise<void> {
  const messages = getMessages(await resolveLocale(ctx, db));
  const keyboard = new InlineKeyboard()
    .text(messages.chatMenu.newEmailButton, CB_NEW_EMAIL.build(chatId))
    .text(messages.chatMenu.listEmailsButton, CB_ALIAS_LIST.build(chatId))
    .row()
    .text(messages.chatMenu.backButton, CB_CHAT_SELECTION);

  await ctx.editMessageText(messages.chatMenu.managing(escapeHtml(chatTitle)), {
    parse_mode: "HTML",
    reply_markup: keyboard,
  });
}
