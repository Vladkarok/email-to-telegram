import type { CommandContext, Context } from "grammy";
import { getDb } from "../../db/client.js";
import { updateAliasStatus } from "../../db/repos/aliases.js";
import { aliasResolutionError, resolveManageableAlias } from "../aliasResolver.js";
import { escapeHtml } from "../../utils/html.js";

export async function resumeemailHandler(ctx: CommandContext<Context>): Promise<void> {
  if (!ctx.from) return;
  const aliasName = ctx.match.trim();

  if (!aliasName) {
    await ctx.reply("Usage: /resumeemail <alias-name>");
    return;
  }

  const result = await resolveManageableAlias(
    getDb(),
    ctx.api,
    ctx.from.id,
    BigInt(ctx.chat.id),
    aliasName,
  );

  if (!result.ok) {
    await ctx.reply(aliasResolutionError(result, aliasName, ctx.chat.type), {
      parse_mode: "HTML",
    });
    return;
  }

  const alias = result.alias;

  if (alias.status === "active") {
    await ctx.reply(`✅ Alias <code>${escapeHtml(alias.fullAddress)}</code> is already active.`, {
      parse_mode: "HTML",
    });
    return;
  }

  await updateAliasStatus(getDb(), alias.id, "active");
  await ctx.reply(
    `▶️ Alias <code>${escapeHtml(alias.fullAddress)}</code> resumed. Emails will be delivered again.`,
    { parse_mode: "HTML" },
  );
}
