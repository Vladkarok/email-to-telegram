import type { Context } from "grammy";
import { getDb } from "../../db/client.js";
import { listAliasesByChat, findAliasesByCreator } from "../../db/repos/aliases.js";
import { findChatById } from "../../db/repos/chats.js";
import type { EmailAddress } from "../../db/schema.js";

export async function listemailHandler(ctx: Context): Promise<void> {
  if (!ctx.from || !ctx.chat) return;

  if (ctx.chat.type === "private") {
    await listAllChats(ctx);
  } else {
    await listForCurrentChat(ctx);
  }
}

async function listForCurrentChat(ctx: Context): Promise<void> {
  const chatId = BigInt(ctx.chat!.id);
  const aliases = await listAliasesByChat(getDb(), chatId);

  if (aliases.length === 0) {
    await ctx.reply("📭 No aliases for this chat.\n\nCreate one with /newemail <name>");
    return;
  }

  const lines = aliases.map(
    (a) => `${statusIcon(a.status)} <code>${a.fullAddress}</code> [${a.renderMode}]`,
  );
  await ctx.reply(`📬 Aliases for this chat (${aliases.length}):\n\n${lines.join("\n")}`, {
    parse_mode: "HTML",
  });
}

async function listAllChats(ctx: Context): Promise<void> {
  const db = getDb();
  const aliases = await findAliasesByCreator(db, BigInt(ctx.from!.id));

  if (aliases.length === 0) {
    await ctx.reply("📭 No aliases yet.\n\nUse /start to create one.");
    return;
  }

  // Group by chatId
  const byChatId = new Map<string, EmailAddress[]>();
  for (const alias of aliases) {
    const key = alias.chatId.toString();
    const group = byChatId.get(key) ?? [];
    group.push(alias);
    byChatId.set(key, group);
  }

  const sections: string[] = [];

  for (const [chatIdStr, chatAliases] of byChatId) {
    const chat = await findChatById(db, BigInt(chatIdStr));
    const chatLabel = chat ? escapeHtml(chat.title) : `Chat ${chatIdStr}`;

    const lines = chatAliases.map(
      (a) => `  ${statusIcon(a.status)} <code>${a.fullAddress}</code> [${a.renderMode}]`,
    );
    sections.push(`<b>${chatLabel}</b>\n${lines.join("\n")}`);
  }

  await ctx.reply(`📬 All your aliases (${aliases.length}):\n\n${sections.join("\n\n")}`, {
    parse_mode: "HTML",
  });
}

function statusIcon(status: string): string {
  if (status === "active") return "✅";
  if (status === "paused") return "⏸";
  return "🗑";
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
