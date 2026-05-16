import type { CommandContext, Context } from "grammy";
import { getDb } from "../../db/client.js";
import { updateAliasStatus } from "../../db/repos/aliases.js";
import { aliasResolutionError, resolveManageableAlias } from "../aliasResolver.js";
import { escapeHtml } from "../../utils/html.js";
import { getMessages, resolveLocale } from "../../i18n/index.js";

export async function pauseemailHandler(ctx: CommandContext<Context>): Promise<void> {
  if (!ctx.from) return;
  const aliasName = ctx.match.trim();
  const locale = await resolveLocale(ctx, getDb());
  const messages = getMessages(locale);

  if (!aliasName) {
    await ctx.reply(messages.aliasActions.pauseUsage);
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
    await ctx.reply(aliasResolutionError(result, aliasName, ctx.chat.type, locale), {
      parse_mode: "HTML",
    });
    return;
  }

  const alias = result.alias;

  if (alias.status === "paused") {
    await ctx.reply(messages.aliasActions.alreadyPaused(escapeHtml(alias.fullAddress)), {
      parse_mode: "HTML",
    });
    return;
  }

  await updateAliasStatus(getDb(), alias.id, "paused");
  await ctx.reply(messages.aliasActions.paused(escapeHtml(alias.fullAddress)), {
    parse_mode: "HTML",
  });
}
