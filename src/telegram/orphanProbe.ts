/**
 * Tri-state chat reachability probe (alias-chat-mobility contract, layer 3).
 *
 * `dead` is an authorization-granting verdict: it is what lets an alias's
 * creator recover it without being a current admin. So `dead` requires a
 * DEFINITIVE, fresh signal — the bot's own membership being left/kicked, or
 * an error class that can only mean the chat is gone. Everything else —
 * timeouts, 429s, 5xx, network failures, anything unrecognized — yields
 * `unknown`, which grants nothing. A transient Telegram outage must never
 * become redirect authority (cycle-1 review finding, critical).
 *
 * A migrate error means the chat is alive under a new id: it triggers
 * migration repair and yields `unknown`, never `dead`.
 */
import type { Api } from "grammy";
import { describeSendError } from "./errorClassifier.js";
import { getLogger } from "../utils/logger.js";

export type Reachability = "reachable" | "dead" | "unknown";

const CACHE_TTL_MS = 60 * 1000;
const CACHE_MAX_SIZE = 5_000;

interface CacheEntry {
  result: Exclude<Reachability, "unknown">;
  expiresAt: number;
}

const reachabilityCache = new Map<string, CacheEntry>();

/**
 * Error descriptions that can only mean "this chat is gone for this bot".
 * Deliberately narrow: anything not listed here is treated as transient.
 */
const DEFINITIVE_DEAD_PATTERNS = [
  "chat not found",
  "bot was kicked",
  "bot is not a member",
  "group chat was deactivated",
  "chat was deleted",
  "user is deactivated",
];

export interface ProbeOptions {
  /** Bypass the cache. Mutation confirmations must always pass this. */
  fresh?: boolean;
  /** Invoked when the probe discovers the chat migrated to a new id. */
  onMigrate?: (oldChatId: bigint, newChatId: bigint) => Promise<void>;
}

export function invalidateReachabilityCache(chatId: bigint): void {
  reachabilityCache.delete(chatId.toString());
}

/** Test seam; also used when the whole cache must be dropped. */
export function clearReachabilityCache(): void {
  reachabilityCache.clear();
}

function cache(chatId: bigint, result: Exclude<Reachability, "unknown">): void {
  if (reachabilityCache.size >= CACHE_MAX_SIZE) {
    const oldest = reachabilityCache.keys().next().value;
    if (oldest !== undefined) reachabilityCache.delete(oldest);
  }
  reachabilityCache.set(chatId.toString(), { result, expiresAt: Date.now() + CACHE_TTL_MS });
}

export async function probeChatReachability(
  api: Api,
  chatId: bigint,
  { fresh = false, onMigrate }: ProbeOptions = {},
): Promise<Reachability> {
  if (!fresh) {
    const cached = reachabilityCache.get(chatId.toString());
    if (cached && cached.expiresAt > Date.now()) return cached.result;
  }

  let botId: number;
  try {
    botId = (await api.getMe()).id;
  } catch {
    return "unknown";
  }

  try {
    const member = await api.getChatMember(Number(chatId), botId);
    // The bot's OWN membership is the authoritative signal. getChat can still
    // succeed for a public chat the bot was removed from, so it is not used.
    const result = member.status === "left" || member.status === "kicked" ? "dead" : "reachable";
    cache(chatId, result);
    return result;
  } catch (err: unknown) {
    const failure = describeSendError(err);

    if (failure.migrateToChatId !== null) {
      // Alive under a new id — repair, and never treat as an orphan.
      if (onMigrate) {
        await onMigrate(chatId, failure.migrateToChatId).catch((repairErr: unknown) => {
          getLogger().error(
            { err: repairErr, chatId: chatId.toString() },
            "orphan probe: migration repair failed",
          );
        });
      }
      return "unknown";
    }

    const description = failure.description.toLowerCase();
    // `code !== null` means this really was a Bot API response, not a
    // transport/transformer exception. Without it, any thrown Error whose
    // message merely CONTAINS a definitive phrase (e.g. a wrapped
    // "fetch failed: chat not found") would be promoted to `dead` and grant
    // orphan recovery — the exact transient-outage-becomes-authority hole the
    // contract forbids.
    const definitive =
      failure.code !== null &&
      failure.transient === false &&
      DEFINITIVE_DEAD_PATTERNS.some((pattern) => description.includes(pattern));

    if (definitive) {
      cache(chatId, "dead");
      return "dead";
    }
    // Unknown is never cached: the next check must probe again.
    return "unknown";
  }
}
