/**
 * Version-CAS mutations for alias routing and existence
 * (alias-chat-mobility contract, docs/plans/2026-07-19-alias-chat-mobility.md).
 *
 * Mail redirection is the most exfiltration-sensitive operation in the bot,
 * so authorization must be bound to the state it authorized. Every
 * confirmation that mutates routing or existence carries the
 * `routing_version` it was authorized against, and executes as
 * `WHERE id = ? AND routing_version = ? AND status <> 'deleted'`.
 *
 * Chat id alone is NOT a valid token: an A→B→A round trip would let a stale
 * confirmation through. Zero rows updated means the caller must re-read,
 * re-authorize and re-confirm — surfaced as a typed `version_conflict`
 * result rather than an exception, because losing the race is an expected
 * outcome, not a fault.
 *
 * Every routing mutation lives here so no caller can bypass the guard.
 */
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { randomUUID } from "crypto";
import { and, eq, ne, sql } from "drizzle-orm";
import {
  aliasMoveEvents,
  emailAddresses,
  type EmailAddress,
  type NewAliasMoveEvent,
} from "../schema.js";
import type * as schema from "../schema.js";
import { buildAliasTombstoneSet } from "./aliases.js";

type Db = NodePgDatabase<typeof schema>;

export type AuthzPath = "admin" | "orphan" | "migration";

export type RoutingMutationResult =
  | { ok: true; alias: EmailAddress }
  | { ok: false; reason: "version_conflict" };

export interface AliasMoveEventInput {
  operationId: string;
  aliasId: string;
  aliasOwnerId: bigint;
  actorId: bigint | null;
  authzPath: AuthzPath;
  oldChatId: bigint;
  newChatId: bigint;
  oldThreadId: bigint | null;
  newThreadId: bigint | null;
  outcome?: "succeeded" | "failed";
}

/**
 * Appends one audit row. Callers must pass a transaction handle that also
 * carries the routing mutation: a move without its audit row cannot exist.
 */
export async function insertAliasMoveEvent(db: Db, event: AliasMoveEventInput): Promise<void> {
  const row: NewAliasMoveEvent = {
    operationId: event.operationId,
    aliasId: event.aliasId,
    aliasOwnerId: event.aliasOwnerId,
    actorId: event.actorId,
    authzPath: event.authzPath,
    oldChatId: event.oldChatId,
    newChatId: event.newChatId,
    oldThreadId: event.oldThreadId,
    newThreadId: event.newThreadId,
    outcome: event.outcome ?? "succeeded",
  };
  await db.insert(aliasMoveEvents).values(row);
}

/**
 * Distinct user ids to lock, ascending. A fixed global order is what makes
 * concurrent two-user locking deadlock-free.
 */
export function lockOrder(...userIds: Array<bigint | null>): bigint[] {
  const distinct = [...new Set(userIds.filter((id): id is bigint => id !== null))];
  return distinct.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** `WHERE id = ? AND routing_version = ? AND status <> 'deleted'`. */
function casCondition(aliasId: string, expectedVersion: number) {
  return and(
    eq(emailAddresses.id, aliasId),
    eq(emailAddresses.routingVersion, expectedVersion),
    ne(emailAddresses.status, "deleted"),
  );
}

export interface MoveAliasParams {
  aliasId: string;
  expectedVersion: number;
  newChatId: bigint;
  /** The route the caller authorized against; recorded for forensics. */
  oldChatId: bigint;
  oldThreadId: bigint | null;
  actorId: bigint | null;
  authzPath: Exclude<AuthzPath, "migration">;
  /** Owner of the alias, for the denormalized audit column. */
  aliasOwnerId: bigint;
  operationId?: string;
}

/**
 * Moves an alias to another chat: re-points the chat, CLEARS the thread
 * (forum targets land in General — thread ids are chat-local), bumps
 * `routing_version`, and writes the audit event in the same transaction.
 */
export async function moveAliasWithCas(
  db: Db,
  params: MoveAliasParams,
): Promise<RoutingMutationResult> {
  return db.transaction(async (tx) => {
    // Same per-user advisory lock the erasure cascade takes, so an in-flight
    // move cannot interleave with /delete_me and leave an audit row behind
    // for a user who no longer exists. BOTH identifiers this transaction
    // writes must be locked — the owner and, when different, the actor.
    //
    // Ascending order keeps concurrent moves deadlock-free with each other.
    // Just as important: these come BEFORE the UPDATE below, which takes the
    // alias row lock. Every writer in the codebase uses that same
    // owner-then-row order (see repairChatMigration and deleteHostedUser);
    // inverting it anywhere reintroduces an ABBA deadlock.
    for (const userId of lockOrder(params.aliasOwnerId, params.actorId)) {
      await tx.execute(sql`select pg_advisory_xact_lock(${userId})`);
    }

    const [alias] = await (tx as Db)
      .update(emailAddresses)
      .set({
        chatId: params.newChatId,
        messageThreadId: null,
        routingVersion: sql`${emailAddresses.routingVersion} + 1`,
        updatedAt: new Date(),
      })
      .where(casCondition(params.aliasId, params.expectedVersion))
      .returning();

    if (!alias) return { ok: false, reason: "version_conflict" };

    await insertAliasMoveEvent(tx as Db, {
      operationId: params.operationId ?? randomUUID(),
      aliasId: params.aliasId,
      aliasOwnerId: params.aliasOwnerId,
      actorId: params.actorId,
      authzPath: params.authzPath,
      oldChatId: params.oldChatId,
      newChatId: params.newChatId,
      oldThreadId: params.oldThreadId,
      newThreadId: null,
    });

    return { ok: true, alias };
  });
}

export interface SetAliasTopicParams {
  aliasId: string;
  expectedVersion: number;
  threadId: bigint | null;
}

/**
 * Sets (or clears) the forum topic. Version-guarded and version-bumping so a
 * stale callback from the pre-move chat can never install a foreign topic id
 * in the alias's new chat. Not a move: no audit row.
 */
export async function setAliasTopicWithCas(
  db: Db,
  params: SetAliasTopicParams,
): Promise<RoutingMutationResult> {
  const [alias] = await db
    .update(emailAddresses)
    .set({
      messageThreadId: params.threadId,
      routingVersion: sql`${emailAddresses.routingVersion} + 1`,
      updatedAt: new Date(),
    })
    .where(casCondition(params.aliasId, params.expectedVersion))
    .returning();

  return alias ? { ok: true, alias } : { ok: false, reason: "version_conflict" };
}

export interface SoftDeleteAliasParams {
  aliasId: string;
  expectedVersion: number;
}

/**
 * Soft-deletes an alias under the same version guard, so a delete confirmed
 * against a pre-move view loses the race instead of silently winning. The
 * version is not bumped: deletion is terminal and `status <> 'deleted'`
 * already makes a replay a no-op.
 */
export async function softDeleteAliasWithCas(
  db: Db,
  params: SoftDeleteAliasParams,
): Promise<RoutingMutationResult> {
  const [alias] = await db
    .update(emailAddresses)
    .set(buildAliasTombstoneSet())
    .where(casCondition(params.aliasId, params.expectedVersion))
    .returning();

  return alias ? { ok: true, alias } : { ok: false, reason: "version_conflict" };
}
