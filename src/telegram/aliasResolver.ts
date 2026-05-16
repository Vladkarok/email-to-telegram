import type { Api } from "grammy";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../db/schema.js";
import type { EmailAddress } from "../db/schema.js";
import {
  findAliasByFullAddress,
  findAliasesByCreator,
  listAliasesByChat,
} from "../db/repos/aliases.js";
import { canManageAlias } from "./authorization.js";
import { getMessages, type Locale, DEFAULT_LOCALE } from "../i18n/index.js";

type Db = NodePgDatabase<typeof schema>;

export type ResolveResult =
  | { ok: true; alias: EmailAddress }
  | { ok: false; reason: "not_found" | "ambiguous" | "forbidden" };

/**
 * Resolves an alias by user-supplied name and verifies the user can manage it.
 *
 * Accepts either a full address (`name@domain.tld`) or just a local part.
 * Resolution order:
 *  1. If the input contains `@`, look up by full address (cross-chat).
 *  2. Otherwise:
 *     a. In a group/supergroup chat: scope strictly to the current chat. We
 *        don't want a stray `/deleteemail foo` in one group to nuke a
 *        same-named alias in another chat.
 *     b. In a private chat (DM): fall back to anything the user created.
 *  3. Verify the user can manage the resolved alias.
 *
 * Returns a discriminated result so callers can render context-appropriate errors.
 */
export async function resolveManageableAlias(
  db: Db,
  api: Api,
  userId: number,
  currentChatId: bigint,
  rawInput: string,
  chatType: string,
): Promise<ResolveResult> {
  const input = rawInput.trim().toLowerCase();
  if (!input) return { ok: false, reason: "not_found" };

  let candidates: EmailAddress[] = [];

  if (input.includes("@")) {
    const exact = await findAliasByFullAddress(db, input);
    if (exact) candidates = [exact];
  } else if (chatType === "private") {
    // DM: search every alias the user owns (the alias's chatId points to the
    // delivery chat, not the DM where the user is typing).
    const owned = await findAliasesByCreator(db, BigInt(userId));
    candidates = owned.filter((a) => a.localPart === input);
  } else {
    // Group: stay strictly within this chat. Operating on aliases from other
    // chats from a group context would be surprising and unsafe.
    candidates = (await listAliasesByChat(db, currentChatId)).filter((a) => a.localPart === input);
  }

  if (candidates.length > 1) return { ok: false, reason: "ambiguous" };

  const alias = candidates[0];
  if (!alias) return { ok: false, reason: "not_found" };
  const allowed = await canManageAlias(db, api, userId, alias.id, { fresh: true });
  if (!allowed) return { ok: false, reason: "forbidden" };

  return { ok: true, alias };
}

/**
 * Returns a context-aware error message for a failed alias resolution.
 *
 * `chatType` should be the Telegram chat type ("private", "group", "supergroup", etc.).
 * In DMs the "in this chat" wording is misleading — the error should just say not found.
 */
export function aliasResolutionError(
  result: Extract<ResolveResult, { ok: false }>,
  rawInput: string,
  chatType: string,
  locale: Locale = DEFAULT_LOCALE,
): string {
  const escaped = escapeForCode(rawInput);
  const messages = getMessages(locale);
  if (result.reason === "ambiguous") {
    return messages.aliasResolver.ambiguous(escaped);
  }
  if (result.reason === "forbidden") {
    return messages.aliasResolver.forbidden;
  }
  if (chatType === "private") {
    return messages.aliasResolver.notFoundDm(escaped);
  }
  return messages.aliasResolver.notFoundGroup(escaped);
}

function escapeForCode(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
