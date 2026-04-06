import type { CommandContext, Context } from "grammy";
import { getDb } from "../../db/client.js";
import { findAliasByIdAndChat, updateAliasStatus } from "../../db/repos/aliases.js";
import { canManageAlias } from "../authorization.js";

export async function resumeemailHandler(ctx: CommandContext<Context>): Promise<void> {
  const localPart = ctx.match.trim();

  if (!localPart) {
    await ctx.reply("Usage: /resumeemail <alias-name>");
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

  if (
    !ctx.from ||
    !(await canManageAlias(getDb(), ctx.api, ctx.from.id, alias.id, { fresh: true }))
  ) {
    await ctx.reply("⛔ Access denied.");
    return;
  }

  if (alias.status === "active") {
    await ctx.reply(`✅ Alias <code>${alias.fullAddress}</code> is already active.`, {
      parse_mode: "HTML",
    });
    return;
  }

  await updateAliasStatus(getDb(), alias.id, "active");
  await ctx.reply(
    `▶️ Alias <code>${alias.fullAddress}</code> resumed. Emails will be delivered again.`,
    { parse_mode: "HTML" },
  );
}
