import type { CommandContext, Context } from "grammy";
import { getDb } from "../../db/client.js";
import { updateAliasStatus } from "../../db/repos/aliases.js";
import { aliasResolutionError, resolveManageableAlias } from "../aliasResolver.js";
import { escapeHtml } from "../../utils/html.js";

export async function deleteemailHandler(ctx: CommandContext<Context>): Promise<void> {
  if (!ctx.from) return;
  const aliasName = ctx.match.trim();

  if (!aliasName) {
    await ctx.reply("Usage: /deleteemail <alias-name>");
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

  await updateAliasStatus(getDb(), alias.id, "deleted");
  await ctx.reply(
    `🗑 Alias <code>${escapeHtml(alias.fullAddress)}</code> deleted. Future emails will be rejected.`,
    { parse_mode: "HTML" },
  );
}
