import type { CommandContext, Context } from "grammy";
import { getDb } from "../../db/client.js";
import { softDeleteAlias } from "../../db/repos/aliases.js";
import { aliasResolutionError, resolveManageableAlias } from "../aliasResolver.js";
import { escapeHtml } from "../../utils/html.js";
import { getMessages, resolveLocale } from "../../i18n/index.js";

export async function deleteemailHandler(ctx: CommandContext<Context>): Promise<void> {
  if (!ctx.from) return;
  const aliasName = ctx.match.trim();
  const locale = await resolveLocale(ctx, getDb());
  const messages = getMessages(locale);

  if (!aliasName) {
    await ctx.reply(messages.aliasActions.deleteUsage);
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

  await softDeleteAlias(getDb(), alias.id);
  await ctx.reply(messages.aliasActions.deleted(escapeHtml(alias.fullAddress)), {
    parse_mode: "HTML",
  });
}
