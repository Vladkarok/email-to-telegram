import type { CommandContext, Context } from "grammy";
import { getDb } from "../../db/client.js";
import { updateAliasStatus } from "../../db/repos/aliases.js";
import { aliasResolutionError, resolveManageableAlias } from "../aliasResolver.js";
import { escapeHtml } from "../../utils/html.js";

export async function pauseemailHandler(ctx: CommandContext<Context>): Promise<void> {
  if (!ctx.from) return;
  const aliasName = ctx.match.trim();

  if (!aliasName) {
    await ctx.reply("Usage: /pauseemail <alias-name>");
    return;
  }

  const result = await resolveManageableAlias(
    getDb(),
    ctx.api,
    ctx.from.id,
    BigInt(ctx.chat.id),
    aliasName,
    ctx.chat.type,
  );

  if (!result.ok) {
    await ctx.reply(aliasResolutionError(result, aliasName, ctx.chat.type), {
      parse_mode: "HTML",
    });
    return;
  }

  const alias = result.alias;

  if (alias.status === "paused") {
    await ctx.reply(`⏸ Alias <code>${escapeHtml(alias.fullAddress)}</code> is already paused.`, {
      parse_mode: "HTML",
    });
    return;
  }

  await updateAliasStatus(getDb(), alias.id, "paused");
  await ctx.reply(
    `⏸ Alias <code>${escapeHtml(alias.fullAddress)}</code> paused. Emails will be rejected until resumed.`,
    { parse_mode: "HTML" },
  );
}
