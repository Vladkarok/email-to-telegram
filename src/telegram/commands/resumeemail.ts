import type { CommandContext, Context } from "grammy";
import { getDb } from "../../db/client.js";
import { updateAliasStatus } from "../../db/repos/aliases.js";
import { aliasResolutionError, resolveManageableAlias } from "../aliasResolver.js";
import { escapeHtml } from "../../utils/html.js";
import { getMessages, resolveLocale } from "../../i18n/index.js";

export async function resumeemailHandler(ctx: CommandContext<Context>): Promise<void> {
  if (!ctx.from) return;
  const aliasName = ctx.match.trim();
  const locale = await resolveLocale(ctx, getDb());
  const messages = getMessages(locale);

  if (!aliasName) {
    await ctx.reply(messages.aliasActions.resumeUsage);
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

  if (alias.status === "active") {
    await ctx.reply(messages.aliasActions.alreadyActive(escapeHtml(alias.fullAddress)), {
      parse_mode: "HTML",
    });
    return;
  }

  await updateAliasStatus(getDb(), alias.id, "active");
  await ctx.reply(messages.aliasActions.resumed(escapeHtml(alias.fullAddress)), {
    parse_mode: "HTML",
  });
}
