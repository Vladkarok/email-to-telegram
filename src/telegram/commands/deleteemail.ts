import type { CommandContext, Context } from "grammy";
import { getDb } from "../../db/client.js";
import { findAliasByIdAndChat, updateAliasStatus } from "../../db/repos/aliases.js";
import { canManageAlias } from "../authorization.js";
import { escapeHtml } from "../../utils/html.js";

export async function deleteemailHandler(ctx: CommandContext<Context>): Promise<void> {
  const localPart = ctx.match.trim();

  if (!localPart) {
    await ctx.reply("Usage: /deleteemail <alias-name>");
    return;
  }

  const chatId = BigInt(ctx.chat.id);
  const alias = await findAliasByIdAndChat(getDb(), localPart, chatId);

  if (!alias) {
    await ctx.reply(`❌ Alias <code>${escapeHtml(localPart)}</code> not found in this chat.`, {
      parse_mode: "HTML",
    });
    return;
  }

  if (
    !ctx.from ||
    !(await canManageAlias(getDb(), ctx.api, ctx.from.id, alias.id, { fresh: true }))
  ) {
    await ctx.reply("⛔ Access denied.");
    return;
  }

  await updateAliasStatus(getDb(), alias.id, "deleted");
  await ctx.reply(
    `🗑 Alias <code>${escapeHtml(alias.fullAddress)}</code> deleted. Future emails will be rejected.`,
    { parse_mode: "HTML" },
  );
}

