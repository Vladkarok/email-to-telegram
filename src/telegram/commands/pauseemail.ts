import type { CommandContext, Context } from "grammy";
import { getDb } from "../../db/client.js";
import { findAliasByIdAndChat, updateAliasStatus } from "../../db/repos/aliases.js";
import { canManageAlias } from "../authorization.js";

export async function pauseemailHandler(ctx: CommandContext<Context>): Promise<void> {
  const localPart = ctx.match.trim();

  if (!localPart) {
    await ctx.reply("Usage: /pauseemail <alias-name>");
    return;
  }

  const chatId = BigInt(ctx.chat.id);
  const alias = await findAliasByIdAndChat(getDb(), localPart, chatId);

  if (!alias) {
    await ctx.reply(`❌ Alias <code>${localPart}</code> not found in this chat.`, {
      parse_mode: "HTML",
    });
    return;
  }

  if (!ctx.from || !(await canManageAlias(getDb(), ctx.api, ctx.from.id, alias.id))) {
    await ctx.reply("⛔ Access denied.");
    return;
  }

  if (alias.status === "paused") {
    await ctx.reply(`⏸ Alias <code>${alias.fullAddress}</code> is already paused.`, {
      parse_mode: "HTML",
    });
    return;
  }

  await updateAliasStatus(getDb(), alias.id, "paused");
  await ctx.reply(
    `⏸ Alias <code>${alias.fullAddress}</code> paused. Emails will be rejected until resumed.`,
    { parse_mode: "HTML" },
  );
}
