import type { Api } from "grammy";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../db/schema.js";
import { findActiveChats } from "../db/repos/chats.js";
import { findAliasById } from "../db/repos/aliases.js";
import type { Chat } from "../db/schema.js";

type Db = NodePgDatabase<typeof schema>;

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface CacheEntry {
  result: boolean;
  expiresAt: number;
}

const chatMemberCache = new Map<string, CacheEntry>();

/**
 * Returns true if the given user can manage the given chat.
 *
 * Rules:
 * - A user always manages their own DM with the bot (chatId === BigInt(userId)).
 * - For groups/supergroups: checks Telegram membership via getChatMember.
 *   Allowed statuses: creator, administrator, member.
 * - Results are cached for 5 minutes to reduce Telegram API calls.
 * - On any error (bot kicked, chat not found, etc.) access is denied.
 */
export async function canManageChat(api: Api, userId: number, chatId: bigint): Promise<boolean> {
  // A user always owns their own private DM with the bot
  if (chatId === BigInt(userId)) return true;

  const cacheKey = `${chatId}:${userId}`;
  const cached = chatMemberCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.result;

  let result: boolean;
  try {
    const member = await api.getChatMember(Number(chatId), userId);
    result = ["creator", "administrator", "member"].includes(member.status);
  } catch {
    // Cannot verify membership (bot not in chat, chat not found, etc.) — deny
    result = false;
  }

  chatMemberCache.set(cacheKey, { result, expiresAt: Date.now() + CACHE_TTL_MS });
  return result;
}

/**
 * Returns only the subset of active chats that the given user can manage.
 * Checks are done in parallel to minimise latency.
 */
export async function getAccessibleChats(db: Db, api: Api, userId: number): Promise<Chat[]> {
  const allChats = await findActiveChats(db);
  const checked = await Promise.all(
    allChats.map(async (chat) => ({
      chat,
      allowed: await canManageChat(api, userId, chat.id),
    })),
  );
  return checked.filter(({ allowed }) => allowed).map(({ chat }) => chat);
}

/**
 * Returns true if the given user can manage the given alias.
 *
 * Rules (OR logic):
 * 1. The user created the alias (`alias.createdBy === BigInt(userId)`).
 * 2. The user can manage the alias's target chat (`canManageChat()`).
 */
export async function canManageAlias(
  db: Db,
  api: Api,
  userId: number,
  aliasId: string,
): Promise<boolean> {
  const alias = await findAliasById(db, aliasId);
  if (!alias) return false;
  if (alias.createdBy === BigInt(userId)) return true;
  return canManageChat(api, userId, alias.chatId);
}
