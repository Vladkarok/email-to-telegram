import { InlineKeyboard } from "grammy";
import type { Context } from "grammy";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../../db/schema.js";
import { getAccessibleChats } from "../authorization.js";

type Db = NodePgDatabase<typeof schema>;

function chatIcon(type: string): string {
  return type === "private" ? "🏠" : "👥";
}

export async function sendChatSelectionMenu(
  ctx: Context,
  db: Db,
  { welcome = false }: { welcome?: boolean } = {},
): Promise<void> {
  if (!ctx.from) return;
  const chats = await getAccessibleChats(db, ctx.api, ctx.from.id);
  const prefix = welcome ? "👋 Welcome! All email aliases are managed here.\n\n" : "";

  if (chats.length === 0) {
    await ctx.reply(
      `${prefix}No chats registered yet.\n\nAdd me to a group to manage email aliases for it, or use me here in DM.`,
    );
    return;
  }

  const keyboard = new InlineKeyboard();
  for (const chat of chats) {
    keyboard.text(`${chatIcon(chat.type)} ${chat.title}`, `cm:${chat.id}`).row();
  }

  await ctx.reply(`${prefix}Select a chat to manage:`, { reply_markup: keyboard });
}

export async function editChatSelectionMenu(ctx: Context, db: Db): Promise<void> {
  if (!ctx.from) return;
  const chats = await getAccessibleChats(db, ctx.api, ctx.from.id);

  if (chats.length === 0) {
    await ctx.editMessageText(
      "No chats registered yet.\n\nAdd me to a group to manage email aliases for it.",
    );
    return;
  }

  const keyboard = new InlineKeyboard();
  for (const chat of chats) {
    keyboard.text(`${chatIcon(chat.type)} ${chat.title}`, `cm:${chat.id}`).row();
  }

  await ctx.editMessageText("Select a chat to manage:", { reply_markup: keyboard });
}

export async function editChatManagementMenu(
  ctx: Context,
  chatId: string,
  chatTitle: string,
): Promise<void> {
  const keyboard = new InlineKeyboard()
    .text("📧 New Email", `cn:${chatId}`)
    .text("📋 List Emails", `cl:${chatId}`)
    .row()
    .text("⬅️ Back", "cs");

  await ctx.editMessageText(`Managing: <b>${escapeHtml(chatTitle)}</b>`, {
    parse_mode: "HTML",
    reply_markup: keyboard,
  });
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
