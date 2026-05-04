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

type Db = NodePgDatabase<typeof schema>;

export type ResolveResult =
  | { ok: true; alias: EmailAddress }
  | { ok: false; reason: "not_found" | "ambiguous" | "forbidden" };

/**
 * Resolves an alias by user-supplied name and verifies the user can manage it.
 *
 * Accepts either a full address (`name@domain.tld`) or just a local part.
 * Resolution order:
 *  1. If the input contains `@`, look up by full address.
 *  2. Otherwise:
 *     a. Prefer an alias in the current chat with matching local part (group context).
 *     b. Fall back to aliases the user created with that local part (DM context).
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
): Promise<ResolveResult> {
  const input = rawInput.trim().toLowerCase();
  if (!input) return { ok: false, reason: "not_found" };

  let candidates: EmailAddress[] = [];

  if (input.includes("@")) {
    const exact = await findAliasByFullAddress(db, input);
    if (exact) candidates = [exact];
  } else {
    // 1. Try current chat first — typical group usage
    const inCurrent = (await listAliasesByChat(db, currentChatId)).filter(
      (a) => a.localPart === input,
    );
    if (inCurrent.length > 0) {
      candidates = inCurrent;
    } else {
      // 2. Fall back to anything the user owns (typical DM usage)
      const owned = await findAliasesByCreator(db, BigInt(userId));
      candidates = owned.filter((a) => a.localPart === input);
    }
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
): string {
  const escaped = escapeForCode(rawInput);
  if (result.reason === "ambiguous") {
    return `❌ Alias <code>${escaped}</code> matches more than one inbox. Use the full address (name@domain.tld) to disambiguate.`;
  }
  if (result.reason === "forbidden") {
    return "⛔ Access denied.";
  }
  if (chatType === "private") {
    return `❌ Alias <code>${escaped}</code> not found. See /listemail for your aliases.`;
  }
  return `❌ Alias <code>${escaped}</code> not found in this chat. See /listemail.`;
}

function escapeForCode(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
