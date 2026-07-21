import type { CommandContext, Context } from "grammy";
import { getDb } from "../../db/client.js";
import { softDeleteAliasWithCas } from "../../db/repos/aliasRouting.js";
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

  // Version-guarded against the alias state this command was authorized on:
  // a concurrent move must not be silently overridden by a stale delete.
  const deletion = await softDeleteAliasWithCas(getDb(), {
    aliasId: alias.id,
    expectedVersion: alias.routingVersion,
  });

  if (!deletion.ok) {
    await ctx.reply(messages.aliasActions.routingChanged, { parse_mode: "HTML" });
    return;
  }

  await ctx.reply(messages.aliasActions.deleted(escapeHtml(alias.fullAddress)), {
    parse_mode: "HTML",
  });
}
