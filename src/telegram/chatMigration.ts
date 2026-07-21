/**
 * Group→supergroup chat-id migration repair (alias-chat-mobility contract,
 * docs/plans/2026-07-19-alias-chat-mobility.md, layer 1).
 *
 * All three observation paths — the `migrate_to_chat_id` service message
 * (fires in the OLD chat), the `migrate_from_chat_id` service message
 * (fires in the NEW chat), and the reactive path (a send failing with
 * `parameters.migrate_to_chat_id`) — funnel into one idempotent
 * `repairChatMigration`, serialized by a per-chat advisory lock keyed on
 * the OLD chat id.
 *
 * Lock order (documented invariant): the chat migration lock is always
 * acquired BEFORE the per-user quota lock. Alias creation targeting a chat
 * takes the same lock via `withChatMigrationLock` and re-verifies the chat
 * row is still active, so creation can never race repair into an alias
 * pointing at a deactivated chat id.
 */
import { randomUUID } from "crypto";
import { sql } from "drizzle-orm";
import type { Api, Context } from "grammy";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../db/schema.js";
import { getDb } from "../db/client.js";
import { findChatById, upsertChat, deactivateChat } from "../db/repos/chats.js";
import { repointAliasesToChat, listAliasOwnersByChat } from "../db/repos/aliases.js";
import { insertAliasMoveEvent, lockOrder } from "../db/repos/aliasRouting.js";
import { invalidateChatAuthorizationCache } from "./authorization.js";
import { invalidateReachabilityCache } from "./orphanProbe.js";
import { getLogger } from "../utils/logger.js";

type Db = NodePgDatabase<typeof schema>;

export interface ChatMigrationMeta {
  title: string;
  type: string;
}

export interface ChatMigrationResult {
  aliasCount: number;
}

/**
 * Runs `work` inside a transaction holding the per-chat migration advisory
 * lock. Used by repair itself and by every mutation that must serialize
 * with repair (alias creation now; alias moves in layer 2).
 */
export async function withChatMigrationLock<T>(
  db: Db,
  chatId: bigint,
  work: (tx: Db) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${chatId})`);
    return work(tx as Db);
  });
}

/**
 * Idempotently re-keys a migrated chat: upserts the new chat row (metadata
 * precedence below), re-points every alias from the old id to the new one,
 * and deactivates the old row — all in one locked transaction. Replays and
 * dual-hook orders are no-op-safe.
 *
 * Metadata precedence for the new row:
 * 1. `meta` (the migrate_from hook's NEW-chat context) — authoritative.
 * 2. An already-registered target row — preserved untouched.
 * 3. `api.getChat(newChatId)` — prefetched OUTSIDE the transaction so the
 *    lock is never held across a network call.
 * 4. The old row's title with type forced to `supergroup` (never `group`);
 *    reconciled on the next observation.
 */
export async function repairChatMigration(
  db: Db,
  api: Api | null,
  oldChatId: bigint,
  newChatId: bigint,
  meta?: ChatMigrationMeta,
): Promise<ChatMigrationResult> {
  let fetched: ChatMigrationMeta | null = null;
  if (!meta) {
    const preRegistered = await findChatById(db, newChatId);
    if (!preRegistered && api) {
      try {
        const chat = await api.getChat(Number(newChatId));
        fetched = {
          title: "title" in chat && chat.title ? chat.title : "Unknown",
          type: chat.type,
        };
      } catch (err: unknown) {
        getLogger().warn(
          { err, newChatId: newChatId.toString() },
          "chat.migration_metadata_fetch_failed",
        );
      }
    }
  }

  const result = await withChatMigrationLock(db, oldChatId, async (tx) => {
    const oldRow = await findChatById(tx, oldChatId);
    const existingNew = await findChatById(tx, newChatId);

    if (meta) {
      await upsertChat(tx, { id: newChatId, title: meta.title, type: meta.type });
    } else if (!existingNew) {
      const fallback = fetched ?? { title: oldRow?.title ?? "Unknown", type: "supergroup" };
      await upsertChat(tx, { id: newChatId, title: fallback.title, type: fallback.type });
    }
    // else: preserve the already-registered target row untouched.

    // Owner locks MUST precede the re-key. `repointAliasesToChat` is an
    // UPDATE, so it takes row locks on the alias rows; every other writer
    // (moveAliasWithCas, deleteHostedUser) takes the owner advisory lock
    // first and the row lock second. Locking owners afterwards would invert
    // that order and deadlock against both. Reading the owners first is safe
    // because the chat migration lock we already hold excludes any new alias
    // being created into this chat, so the set cannot grow underneath us.
    //
    // The locks themselves are what stops an audit event being written behind
    // an in-flight /delete_me erasure pass; ascending order keeps concurrent
    // repairs deadlock-free with each other.
    for (const ownerId of lockOrder(...(await listAliasOwnersByChat(tx, oldChatId)))) {
      await tx.execute(sql`select pg_advisory_xact_lock(${ownerId})`);
    }

    const repointed = await repointAliasesToChat(tx, oldChatId, newChatId);

    // One audit event per affected alias, all sharing this migration's
    // operation id, with no actor — an id migration is data continuity, not
    // a user-authorized move. Written in the repair transaction: if the
    // audit fails, the re-key rolls back with it.
    const operationId = randomUUID();
    for (const alias of repointed) {
      await insertAliasMoveEvent(tx, {
        operationId,
        aliasId: alias.id,
        aliasOwnerId: alias.createdBy,
        actorId: null,
        authzPath: "migration",
        oldChatId,
        newChatId,
        // A migration preserves the topic (unlike a move); both sides are
        // recorded so the audit shows the thread survived the re-key.
        oldThreadId: alias.messageThreadId,
        newThreadId: alias.messageThreadId,
      });
    }

    await deactivateChat(tx, oldChatId);
    return { aliasCount: repointed.length };
  });

  // A cached admin check against either id may now be wrong (old chat is
  // dead; the new chat has its own membership state). The reachability cache
  // matters just as much: a stale verdict for either id could otherwise grant
  // or deny orphan recovery for a chat that just moved.
  invalidateChatAuthorizationCache(oldChatId);
  invalidateChatAuthorizationCache(newChatId);
  invalidateReachabilityCache(oldChatId);
  invalidateReachabilityCache(newChatId);

  getLogger().info(
    {
      oldChatId: oldChatId.toString(),
      newChatId: newChatId.toString(),
      aliasCount: result.aliasCount,
    },
    "chat.migrated",
  );
  return result;
}

/**
 * `migrate_to_chat_id` service message — fires in the OLD chat, whose
 * update context describes the OLD group and must NOT supply metadata for
 * the new row.
 */
export async function migrateToChatIdHandler(ctx: Context): Promise<void> {
  const newChatId = ctx.message?.migrate_to_chat_id;
  if (newChatId === undefined || !ctx.chat) return;
  await repairChatMigration(getDb(), ctx.api, BigInt(ctx.chat.id), BigInt(newChatId));
}

/**
 * `migrate_from_chat_id` service message — fires in the NEW supergroup;
 * its chat context is authoritative metadata for the new row.
 */
export async function migrateFromChatIdHandler(ctx: Context): Promise<void> {
  const oldChatId = ctx.message?.migrate_from_chat_id;
  if (oldChatId === undefined || !ctx.chat) return;
  const title = "title" in ctx.chat && ctx.chat.title ? ctx.chat.title : "Unknown";
  await repairChatMigration(getDb(), ctx.api, BigInt(oldChatId), BigInt(ctx.chat.id), {
    title,
    type: ctx.chat.type,
  });
}
