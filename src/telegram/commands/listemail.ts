import type { Context } from "grammy";
import { getDb } from "../../db/client.js";
import { listAliasesByChat, findAliasesByCreator } from "../../db/repos/aliases.js";
import { findChatById } from "../../db/repos/chats.js";
import type { EmailAddress } from "../../db/schema.js";
import { canManageAlias, canManageChat } from "../authorization.js";
import { escapeHtml } from "../../utils/html.js";

export async function listemailHandler(ctx: Context): Promise<void> {
  if (!ctx.from || !ctx.chat) return;

  if (ctx.chat.type === "private") {
    await listAllChats(ctx);
  } else {
    await listForCurrentChat(ctx);
  }
}

async function listForCurrentChat(ctx: Context): Promise<void> {
  if (!ctx.from) return;
  const chatId = BigInt(ctx.chat!.id);
  const db = getDb();

  if (!(await canManageChat(ctx.api, ctx.from.id, chatId, { fresh: true }))) {
    await ctx.reply("⛔ Access denied.");
    return;
  }

  const aliases = await filterVisibleAliases(ctx, db, await listAliasesByChat(db, chatId));

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
  const visibleAliases = await filterVisibleAliases(ctx, db, aliases);

  if (visibleAliases.length === 0) {
    await ctx.reply("📭 No aliases yet.\n\nUse /start to create one.");
    return;
  }

  // Group by chatId
  const byChatId = new Map<string, EmailAddress[]>();
  for (const alias of visibleAliases) {
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

  await ctx.reply(`📬 All your aliases (${visibleAliases.length}):\n\n${sections.join("\n\n")}`, {
    parse_mode: "HTML",
  });
}

function statusIcon(status: string): string {
  if (status === "active") return "✅";
  if (status === "paused") return "⏸";
  return "🗑";
}

async function filterVisibleAliases(
  ctx: Context,
  db: ReturnType<typeof getDb>,
  aliases: EmailAddress[],
) {
  if (!ctx.from) return [];
  const checked = await Promise.all(
    aliases.map(async (alias) => ({
      alias,
      allowed: await canManageAlias(db, ctx.api, ctx.from!.id, alias.id),
    })),
  );
  return checked.filter(({ allowed }) => allowed).map(({ alias }) => alias);
}

