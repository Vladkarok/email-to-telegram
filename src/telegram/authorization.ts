import type { Api } from "grammy";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { loadConfig } from "../config.js";
import type * as schema from "../db/schema.js";
import { getDb } from "../db/client.js";
import { findActiveChats, findChatById } from "../db/repos/chats.js";
import { findAliasById } from "../db/repos/aliases.js";
import { userHasOrganizationRole } from "../db/repos/organizationMembers.js";
import type { Chat } from "../db/schema.js";

type Db = NodePgDatabase<typeof schema>;

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const CACHE_MAX_SIZE = 10_000; // cap to prevent unbounded growth

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
 * - Pass `fresh: true` for mutation paths to bypass the cache and get a live
 *   membership check, preventing a kicked user from acting during the TTL window.
 * - On any error (bot kicked, chat not found, etc.) access is denied.
 */
export async function canManageChat(
  api: Api,
  userId: number,
  chatId: bigint,
  { fresh = false }: { fresh?: boolean } = {},
): Promise<boolean> {
  if (!(await canAccessHostedChatTenant(userId, chatId))) return false;

  // A user always owns their own private DM with the bot
  if (chatId === BigInt(userId)) return true;

  const cacheKey = `${chatId}:${userId}`;
  if (!fresh) {
    const cached = chatMemberCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.result;
  }

  let result: boolean;
  try {
    // Use string form to avoid Number() truncation for large Telegram IDs
    const member = await api.getChatMember(chatId.toString(), userId);
    result = ["creator", "administrator", "member"].includes(member.status);
  } catch {
    // Cannot verify membership (bot not in chat, chat not found, etc.) — deny
    result = false;
  }

  // Evict stale entry and enforce max size before inserting
  chatMemberCache.delete(cacheKey);
  if (chatMemberCache.size >= CACHE_MAX_SIZE) {
    // Evict the oldest (first inserted) entry
    const firstKey = chatMemberCache.keys().next().value;
    if (firstKey !== undefined) chatMemberCache.delete(firstKey);
  }
  chatMemberCache.set(cacheKey, { result, expiresAt: Date.now() + CACHE_TTL_MS });
  return result;
}

async function canAccessHostedChatTenant(userId: number, chatId: bigint): Promise<boolean> {
  if (loadConfig().appMode !== "hosted") return true;

  const db = getDb();
  const chat = await findChatById(db, chatId);
  if (!chat?.organizationId) return false;

  return userHasOrganizationRole(db, chat.organizationId, BigInt(userId), [
    "owner",
    "admin",
    "member",
  ]);
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
 *
 * Pass `fresh: true` on mutation paths (text commands, message handlers) to
 * bypass the 5-min cache and get a live membership check. Callback query
 * handlers must NOT use `fresh: true` because the live getChatMember() call
 * may exceed Telegram's 10s callback-answer deadline.
 */
export async function canManageAlias(
  db: Db,
  api: Api,
  userId: number,
  aliasId: string,
  { fresh = false }: { fresh?: boolean } = {},
): Promise<boolean> {
  const alias = await findAliasById(db, aliasId);
  // Reject missing or soft-deleted aliases
  if (!alias || alias.status === "deleted") return false;
  if (!(await canAccessHostedAliasTenant(db, userId, alias.organizationId))) return false;
  if (alias.createdBy === BigInt(userId)) return true;
  return canManageChat(api, userId, alias.chatId, { fresh });
}

async function canAccessHostedAliasTenant(
  db: Db,
  userId: number,
  organizationId: string | null,
): Promise<boolean> {
  if (loadConfig().appMode !== "hosted") return true;
  if (!organizationId) return false;

  return userHasOrganizationRole(db, organizationId, BigInt(userId), ["owner", "admin", "member"]);
}
