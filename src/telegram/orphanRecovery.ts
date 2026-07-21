/**
 * Orphan recovery authorization (alias-chat-mobility contract, layer 3).
 *
 * PURPOSE-SCOPED, and deliberately separate from `canManageAlias`, whose
 * semantics are unchanged. This decision is consulted ONLY by the orphan
 * list, orphan move, and orphan delete flows — never by allow rules,
 * settings, pause/resume, or any other mutation. Losing admin in a LIVE
 * chat therefore never grants recovery: the chat must be definitively dead.
 *
 * Two conditions, both required:
 *   1. the actor created the alias, and
 *   2. the alias's chat probes as `dead` (never `unknown`).
 */
import type { Api } from "grammy";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../db/schema.js";
import type { EmailAddress } from "../db/schema.js";
import { findAliasById, findAliasesByCreator } from "../db/repos/aliases.js";
import { probeChatReachability, type ProbeOptions } from "./orphanProbe.js";
import { repairChatMigration } from "./chatMigration.js";
import { getLogger } from "../utils/logger.js";

type Db = NodePgDatabase<typeof schema>;

/**
 * Probing can be the first thing to notice a chat migrated (if both service
 * hooks were missed while the bot was down). The contract requires that
 * observation to trigger repair, so every probe from here carries the hook.
 */
function migrationRepairHook(db: Db, api: Api): ProbeOptions["onMigrate"] {
  return async (oldChatId: bigint, newChatId: bigint) => {
    await repairChatMigration(db, api, oldChatId, newChatId).catch((err: unknown) => {
      getLogger().error(
        { err, oldChatId: oldChatId.toString(), newChatId: newChatId.toString() },
        "orphan probe: migration repair failed",
      );
    });
  };
}

export async function canRecoverOrphanAlias(
  db: Db,
  api: Api,
  actorId: number,
  aliasId: string,
  options: ProbeOptions = {},
): Promise<boolean> {
  const alias = await findAliasById(db, aliasId);
  if (!alias || alias.status === "deleted") return false;
  if (alias.createdBy !== BigInt(actorId)) return false;

  const verdict = await probeChatReachability(api, alias.chatId, {
    onMigrate: migrationRepairHook(db, api),
    ...options,
  });
  return verdict === "dead";
}

/**
 * The actor's aliases whose chats are definitively dead. Used by the DM
 * `/listemail` "unreachable" section. Chats are probed once each, not once
 * per alias.
 *
 * Pass `candidates` to restrict the probe to aliases already known to be
 * unmanageable — probing chats the caller can demonstrably reach is a wasted
 * Telegram round-trip per chat.
 */
export async function listRecoverableOrphans(
  db: Db,
  api: Api,
  actorId: number,
  candidates?: EmailAddress[],
): Promise<EmailAddress[]> {
  const own = (candidates ?? (await findAliasesByCreator(db, BigInt(actorId)))).filter(
    (alias) => alias.status !== "deleted" && alias.createdBy === BigInt(actorId),
  );
  if (own.length === 0) return [];

  const distinctChatIds = [...new Set(own.map((alias) => alias.chatId))];
  const onMigrate = migrationRepairHook(db, api);
  const verdicts = new Map<bigint, string>();
  await Promise.all(
    distinctChatIds.map(async (chatId) => {
      verdicts.set(chatId, await probeChatReachability(api, chatId, { onMigrate }));
    }),
  );

  return own.filter((alias) => verdicts.get(alias.chatId) === "dead");
}
