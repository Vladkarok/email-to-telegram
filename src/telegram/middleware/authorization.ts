/**
 * Callback-query authorization guards.
 *
 * Layering:
 *   telegram/authorization.ts          — pure permission predicates (canManageChat,
 *                                         canManageAlias). Also used by non-callback paths.
 *   telegram/middleware/authorization.ts — callback-query guards that answer the query
 *                                         with "Access denied" on failure and return false.
 */
import type { Context, CallbackQueryContext } from "grammy";
import { getDb } from "../../db/client.js";
import { canManageChat, canManageAlias } from "../authorization.js";
import { findChatById } from "../../db/repos/chats.js";
import { findAliasById } from "../../db/repos/aliases.js";
import { hasActiveHostedOrganization } from "../../billing/limits.js";

export async function assertChatAccess(
  ctx: CallbackQueryContext<Context>,
  chatId: bigint,
): Promise<boolean> {
  if (!ctx.from) {
    await ctx.answerCallbackQuery("⛔ Access denied");
    return false;
  }
  const allowed = await canManageChat(ctx.api, ctx.from.id, chatId);
  if (!allowed) await ctx.answerCallbackQuery("⛔ Access denied");
  return allowed;
}

export async function assertAliasAccess(
  ctx: CallbackQueryContext<Context>,
  aliasId: string,
): Promise<boolean> {
  if (!ctx.from) {
    await ctx.answerCallbackQuery("⛔ Access denied");
    return false;
  }
  const allowed = await canManageAlias(getDb(), ctx.api, ctx.from.id, aliasId);
  if (!allowed) await ctx.answerCallbackQuery("⛔ Access denied");
  return allowed;
}

export async function assertHostedChatWorkspaceReady(
  ctx: CallbackQueryContext<Context>,
  chatId: bigint,
): Promise<boolean> {
  const chat = await findChatById(getDb(), chatId);
  if (await hasActiveHostedOrganization(getDb(), chat?.organizationId ?? null)) {
    return true;
  }

  await ctx.answerCallbackQuery("⛔ Hosted workspace inactive");
  return false;
}

export async function assertHostedAliasWorkspaceReady(
  ctx: CallbackQueryContext<Context>,
  aliasId: string,
): Promise<boolean> {
  const alias = await findAliasById(getDb(), aliasId);
  if (!alias) return true;
  if (await hasActiveHostedOrganization(getDb(), alias.organizationId ?? null)) {
    return true;
  }

  await ctx.answerCallbackQuery("⛔ Hosted workspace inactive");
  return false;
}
