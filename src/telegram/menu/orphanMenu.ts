/**
 * Orphan-recovery surface (alias-chat-mobility contract, layer 3).
 *
 * Exposes EXACTLY two actions — Move and Delete. No allow rules, no
 * settings, no pause/resume: the creator-fallback authorization is scoped to
 * recovery only, and this menu must not become a back door to the rest of
 * alias management.
 *
 * Every entry point re-checks `canRecoverOrphanAlias` FRESH, so a stale
 * callback against a chat that has come back to life is denied.
 */
import { InlineKeyboard } from "grammy";
import type { Context } from "grammy";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../../db/schema.js";
import { findAliasById } from "../../db/repos/aliases.js";
import { softDeleteAliasWithCas } from "../../db/repos/aliasRouting.js";
import { canRecoverOrphanAlias } from "../orphanRecovery.js";
import { escapeHtml } from "../../utils/html.js";
import { getMessages, resolveLocale } from "../../i18n/index.js";
import { getLogger } from "../../utils/logger.js";
import { CB_ALIAS_MOVE, CB_ALIAS_ORPHAN_DELETE } from "../callbacks.js";

type Db = NodePgDatabase<typeof schema>;

/** The recovery menu: Move or Delete, nothing else. */
export async function editOrphanMenu(ctx: Context, db: Db, aliasId: string): Promise<void> {
  const messages = getMessages(await resolveLocale(ctx, db));
  if (!ctx.from) return;

  const alias = await findAliasById(db, aliasId);
  if (!alias) {
    await ctx.answerCallbackQuery(messages.common.aliasNotFoundShort);
    return;
  }

  if (!(await canRecoverOrphanAlias(db, ctx.api, ctx.from.id, aliasId, { fresh: true }))) {
    // Either not the creator, or the chat is reachable again — in both cases
    // normal management rules apply and recovery is not available.
    await ctx.answerCallbackQuery(messages.listemail.orphanUnavailable);
    return;
  }

  const keyboard = new InlineKeyboard()
    .text(messages.aliasMenu.moveButton, CB_ALIAS_MOVE.build(alias.id))
    .row()
    .text(
      messages.aliasMenu.deleteButton,
      CB_ALIAS_ORPHAN_DELETE.build(alias.id, alias.routingVersion),
    );

  // Answered here rather than by the caller: this menu is reached both from
  // the orphan list and as the fallback for a detail-menu callback, and every
  // path through it must answer the query exactly once.
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(messages.listemail.orphanMenuHeader(escapeHtml(alias.fullAddress)), {
    parse_mode: "HTML",
    reply_markup: keyboard,
  });
}

/** Deletes an orphaned alias, freeing its name via the tombstone path. */
export async function executeOrphanDelete(
  ctx: Context,
  db: Db,
  aliasId: string,
  expectedVersion: number,
): Promise<void> {
  const messages = getMessages(await resolveLocale(ctx, db));
  if (!ctx.from) return;

  if (!(await canRecoverOrphanAlias(db, ctx.api, ctx.from.id, aliasId, { fresh: true }))) {
    await ctx.answerCallbackQuery(messages.listemail.orphanUnavailable);
    return;
  }

  const alias = await findAliasById(db, aliasId);
  if (!alias) {
    await ctx.answerCallbackQuery(messages.common.aliasNotFoundShort);
    return;
  }

  const deleted = await softDeleteAliasWithCas(db, { aliasId, expectedVersion });
  if (!deleted.ok) {
    await ctx.editMessageText(messages.aliasActions.routingChanged, { parse_mode: "HTML" });
    return;
  }

  getLogger().info({ aliasId, action: "delete", actor: ctx.from.id }, "alias.orphan.recovered");

  await ctx.editMessageText(messages.aliasActions.deleted(escapeHtml(alias.fullAddress)), {
    parse_mode: "HTML",
  });
}
