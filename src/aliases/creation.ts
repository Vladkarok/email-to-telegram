/**
 * Creating an alias for a chat: naming, abuse checks, locks, plan limit and
 * the insert, with no Telegram in sight. `/newemail`, the auto-name button
 * and the pending name reply authorize first and then map the result to a
 * reply.
 *
 * Outcomes decided inside the chat-migration transaction (migrated chat,
 * plan limit, rate limit, unavailable shared domain, name conflict) are
 * thrown there, so the transaction rolls back the shared-domain provisioning
 * and the hosted attempt reservation, and turned into a result only here at
 * the edge.
 */
import { customAlphabet } from "nanoid";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../db/schema.js";
import type { EmailAddress } from "../db/schema.js";
import type { AppConfig } from "../config.js";
import { createAlias, findRecentAliasTombstone, listAliasesByChat } from "../db/repos/aliases.js";
import { findChatById } from "../db/repos/chats.js";
import {
  ensureSharedInboundDomain,
  SharedInboundDomainUnavailableError,
} from "../db/repos/inboundDomains.js";
import { checkAliasCreateLimit, withUserQuotaLock, type LimitResult } from "../billing/limits.js";
import {
  HostedAliasCreateRateLimitError,
  reserveHostedAliasCreateAttempt,
} from "../abuse/hostedAliasCreation.js";
import {
  AliasImpersonationError,
  assertAliasNotImpersonation,
} from "../abuse/aliasImpersonationGuard.js";
import { withChatMigrationLock } from "../telegram/chatMigration.js";

type Db = NodePgDatabase<typeof schema>;

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const generateSuffix = customAlphabet(ALPHABET, 6);

/** Validates user-supplied name before lowercasing */
const NAME_RE = /^[a-z0-9._-]{1,32}$/;

/** Maximum candidate-name attempts before giving up. */
const MAX_NAME_ATTEMPTS = 5;

/**
 * How long a freshly deleted name is reserved against claims by a different
 * user (anti name-squatting). The deleting user may reuse it immediately.
 */
const NAME_REUSE_COOLDOWN_HOURS = 24;

/** Postgres error code for unique-constraint violations. */
const PG_UNIQUE_VIOLATION = "23505";

/** Cap cause-chain traversal in case of cyclic `cause` references. */
const MAX_CAUSE_DEPTH = 5;

/** The config fields that decide an alias's domain. */
export type AliasDomainConfig = Pick<AppConfig, "appMode" | "mailDomain" | "hostedMailDomain">;

export interface AliasCreationInput {
  /** The acting Telegram user; becomes the alias owner. */
  createdBy: bigint;
  chatId: bigint;
  threadId: bigint | null;
  /** The name the user asked for, or null for an automatic `inbox` name. */
  requestedName: string | null;
}

export type AliasCreationResult =
  | { kind: "created"; alias: EmailAddress }
  /** The requested name is longer than 32 characters. */
  | { kind: "name_too_long" }
  /** The requested name has characters outside `[a-z0-9._-]`. */
  | { kind: "invalid_name" }
  /** Hosted mode: the requested name looks like a brand. */
  | { kind: "impersonation" }
  /** The requested name was deleted by another user less than 24 hours ago. */
  | { kind: "name_cooldown" }
  /** Migration repair deactivated the chat while creation waited for its lock. */
  | { kind: "chat_migrated" }
  /** The plan refused one more alias (or the hosted user is missing). */
  | { kind: "limit"; limit: Exclude<LimitResult, { ok: true }> }
  /** Hosted mode: too many creation attempts today. */
  | { kind: "rate_limited" }
  /** Hosted mode: the shared inbound domain is not usable. */
  | { kind: "domain_unavailable" }
  /** The requested name is already taken; requested names are never suffixed. */
  | { kind: "name_taken" }
  /** Every automatic candidate was cooling down or taken. */
  | { kind: "no_unique_name" };

/**
 * An outcome decided inside the creation transaction. Throwing it rolls the
 * transaction back; `createAliasForChat` turns it into its result.
 */
class AliasCreationAborted extends Error {
  constructor(readonly result: AliasCreationResult) {
    super(`alias creation aborted: ${result.kind}`);
    this.name = "AliasCreationAborted";
  }
}

async function nextInboxName(db: Db, chatId: bigint): Promise<string> {
  const aliases = await listAliasesByChat(db, chatId);
  let maxN = 0;
  let plainInboxTaken = false;
  const re = /^inbox-(\d+)$/;
  for (const a of aliases) {
    if (a.localPart === "inbox") {
      plainInboxTaken = true;
      continue;
    }
    const m = a.localPart.match(re);
    if (m && m[1]) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && n > maxN) maxN = n;
    }
  }
  if (!plainInboxTaken && maxN === 0) return "inbox";
  return `inbox-${Math.max(maxN, 1) + 1}`;
}

/**
 * Walks the error `cause` chain: drizzle-orm >= 0.44 wraps driver errors in
 * DrizzleQueryError, whose own message no longer carries the pg constraint
 * text — the original pg error (code 23505) lives on `cause`.
 */
function isLocalPartConflict(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; current instanceof Error && depth < MAX_CAUSE_DEPTH; depth++) {
    if ((current as Error & { code?: unknown }).code === PG_UNIQUE_VIOLATION) return true;
    const msg = current.message;
    if (
      msg.includes("idx_alias_local_part") ||
      msg.includes("idx_alias_domain_local_part") ||
      msg.includes("duplicate key value") ||
      msg.includes("unique constraint")
    ) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

/**
 * Creates an alias in `input.chatId`, trying up to five candidate names.
 * Unexpected errors propagate.
 */
export async function createAliasForChat(
  db: Db,
  input: AliasCreationInput,
  config: AliasDomainConfig,
): Promise<AliasCreationResult> {
  const { createdBy, chatId, threadId, requestedName } = input;

  if (requestedName !== null) {
    if (requestedName.length > 32) return { kind: "name_too_long" };
    if (!NAME_RE.test(requestedName)) return { kind: "invalid_name" };
    try {
      assertAliasNotImpersonation(requestedName);
    } catch (err) {
      if (err instanceof AliasImpersonationError) return { kind: "impersonation" };
      throw err;
    }
  }

  const baseName = requestedName ?? (await nextInboxName(db, chatId));
  const cooldownSince = new Date(Date.now() - NAME_REUSE_COOLDOWN_HOURS * 60 * 60 * 1000);

  for (let attempt = 0; attempt < MAX_NAME_ATTEMPTS; attempt++) {
    const candidate = attempt === 0 ? baseName : `${baseName}-${generateSuffix()}`;

    const tombstone = await findRecentAliasTombstone(db, candidate, cooldownSince);
    if (tombstone && tombstone.createdBy !== createdBy) {
      if (requestedName !== null) return { kind: "name_cooldown" };
      continue;
    }

    try {
      // Lock order (alias-chat-mobility contract): the per-chat migration
      // lock is taken BEFORE the per-user quota lock, so creation can never
      // interleave with a migration repair of this chat. The quota lock
      // nests as a savepoint on the same transaction.
      const alias = await withChatMigrationLock(db, chatId, async (lockTx) => {
        // Repair may have won the race and deactivated this chat id while we
        // waited for the lock; a new alias must never point at a dead chat.
        const chatRow = await findChatById(lockTx, chatId);
        if (chatRow?.isActive === false) throw new AliasCreationAborted({ kind: "chat_migrated" });

        return withUserQuotaLock(lockTx, createdBy, async (tx) => {
          const inboundDomain =
            config.appMode === "hosted"
              ? await ensureSharedInboundDomain(tx, config.hostedMailDomain!)
              : null;
          const fullAddress = `${candidate}@${inboundDomain?.domain ?? config.mailDomain}`;
          const limit = await checkAliasCreateLimit(tx, createdBy);
          if (!limit.ok) throw new AliasCreationAborted({ kind: "limit", limit });

          await reserveHostedAliasCreateAttempt(tx, createdBy);

          return createAlias(tx, {
            localPart: candidate,
            fullAddress,
            domainId: inboundDomain?.id ?? null,
            chatId,
            messageThreadId: threadId,
            createdBy,
            renderMode: "html",
            privacyModeEnabled: false,
            bodyDedupEnabled: false,
            status: "active",
          });
        });
      });
      return { kind: "created", alias };
    } catch (err: unknown) {
      if (err instanceof AliasCreationAborted) return err.result;
      if (err instanceof HostedAliasCreateRateLimitError) return { kind: "rate_limited" };
      if (err instanceof SharedInboundDomainUnavailableError) return { kind: "domain_unavailable" };
      if (isLocalPartConflict(err)) {
        // A user-chosen name is sacred: don't silently hand back a suffixed
        // variant — tell them it's taken. Auto-names retry with a suffix.
        if (requestedName !== null) return { kind: "name_taken" };
        continue;
      }
      throw err;
    }
  }

  return { kind: "no_unique_name" };
}
