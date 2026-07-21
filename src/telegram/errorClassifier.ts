/**
 * Coarse classification of Telegram/grammY send errors, shared by
 * observability (metric labels) and the delivery retry policy.
 *
 * Classification prefers the structured Bot API failure (error code +
 * description + parameters) captured by `describeSendError`. The string
 * path remains for callers that only have a flattened message, e.g.
 * persisted `error_text` from delivery attempts, where grammY renders
 * failures as "Call to 'sendMessage' failed! (403: Forbidden: bot was
 * blocked by the user)".
 */

export type TelegramErrorClass =
  | "flood_wait"
  | "forbidden"
  | "chat_not_found"
  | "migrated"
  | "bad_request"
  | "timeout"
  | "network"
  | "server"
  | "other"
  | "unknown";

export type RetryDisposition = "fail_permanently" | "retry_uncounted" | "retry_counted";

/**
 * Structured Telegram send failure, produced by `describeSendError` at the
 * point a send throws and carried through the delivery pipeline.
 *
 * - `transient` — the same destination may succeed on an immediate retry
 *   (Telegram or the path to it is down, or we are rate limited).
 * - `migrateToChatId` — Telegram's `parameters.migrate_to_chat_id`: the
 *   chat upgraded to a supergroup and all future sends must target this
 *   new id. Never transient for the old id; the delivery orchestration
 *   (not the sender) is responsible for migration repair.
 */
export interface TelegramSendFailure {
  code: number | null;
  description: string;
  transient: boolean;
  migrateToChatId: bigint | null;
}

/**
 * Error classes that do not consume the per-email retry budget: they signal
 * Telegram (or the path to it) being unavailable, not this message or chat
 * being undeliverable. Affected deliveries stay retryable until their raw
 * email TTL expires. `migrated` belongs here: the chat still exists under a
 * new id, and once migration repair re-points the alias the retry succeeds.
 */
export const UNCOUNTED_RETRY_ERROR_CLASSES: readonly TelegramErrorClass[] = [
  "flood_wait",
  "timeout",
  "network",
  "server",
  "migrated",
];

/**
 * Classes safe to retry against the SAME destination without repair. A
 * `migrated` failure is deliberately excluded: retrying the old chat id can
 * never succeed, so the sender must stop immediately.
 */
const TRANSIENT_SEND_ERROR_CLASSES: readonly TelegramErrorClass[] = [
  "flood_wait",
  "timeout",
  "network",
  "server",
];

interface BotApiErrorShape {
  error_code: number;
  description: string;
  parameters?: { migrate_to_chat_id?: number };
}

/**
 * Duck-typed detection of grammY's GrammyError (or anything else carrying
 * the Bot API failure fields). Avoids instanceof so tests and wrapped
 * errors with the same shape classify identically.
 */
function asBotApiError(err: unknown): BotApiErrorShape | null {
  if (typeof err !== "object" || err === null) return null;
  const candidate = err as Partial<BotApiErrorShape>;
  if (typeof candidate.error_code !== "number") return null;
  if (typeof candidate.description !== "string") return null;
  return candidate as BotApiErrorShape;
}

/**
 * Convert a thrown send error into the structured failure the delivery
 * pipeline works with. Bot API errors keep their code, description and
 * migrate hint; everything else (timeouts, HttpError, transformer errors)
 * falls back to message-string classification.
 */
export function describeSendError(err: unknown): TelegramSendFailure {
  const apiError = asBotApiError(err);
  if (apiError) {
    const migrateRaw = apiError.parameters?.migrate_to_chat_id;
    const failure = {
      code: apiError.error_code,
      description: apiError.description,
      migrateToChatId: typeof migrateRaw === "number" ? BigInt(migrateRaw) : null,
    };
    return {
      ...failure,
      transient: TRANSIENT_SEND_ERROR_CLASSES.includes(classifyStructured(failure)),
    };
  }

  const description = err instanceof Error ? err.message : String(err);
  return {
    code: null,
    description,
    migrateToChatId: null,
    transient: TRANSIENT_SEND_ERROR_CLASSES.includes(classifyString(description)),
  };
}

export function classifyTelegramError(
  error: string | TelegramSendFailure | null | undefined,
): TelegramErrorClass {
  if (typeof error === "object" && error !== null) return classifyStructured(error);
  return classifyString(error);
}

function classifyStructured(
  failure: Pick<TelegramSendFailure, "code" | "description" | "migrateToChatId">,
): TelegramErrorClass {
  const normalized = failure.description.toLowerCase();
  if (failure.migrateToChatId !== null || normalized.includes("upgraded to a supergroup")) {
    return "migrated";
  }
  if (failure.code === 429) return "flood_wait";
  if (failure.code === 403) return "forbidden";
  if (failure.code === 400) {
    if (normalized.includes("chat not found") || normalized.includes("thread not found")) {
      return "chat_not_found";
    }
    return "bad_request";
  }
  if (failure.code !== null && failure.code >= 500) return "server";
  return classifyString(failure.description);
}

function classifyString(error: string | null | undefined): TelegramErrorClass {
  const normalized = (error ?? "").toLowerCase();
  if (!normalized) return "unknown";
  // Must run before the generic bad_request match: Telegram reports it as
  // "400 Bad Request: group chat was upgraded to a supergroup chat".
  if (normalized.includes("upgraded to a supergroup")) return "migrated";
  if (
    normalized.includes("flood") ||
    normalized.includes("too many requests") ||
    normalized.includes("retry after")
  ) {
    return "flood_wait";
  }
  if (normalized.includes("forbidden") || normalized.includes("blocked")) return "forbidden";
  // Must run before the generic bad_request match: Telegram reports these as
  // "400 Bad Request: chat not found" / "message thread not found".
  if (normalized.includes("chat not found") || normalized.includes("thread not found")) {
    return "chat_not_found";
  }
  if (normalized.includes("bad request")) return "bad_request";
  if (normalized.includes("timeout") || normalized.includes("timed out")) return "timeout";
  if (
    normalized.includes("network") ||
    normalized.includes("econn") ||
    normalized.includes("fetch")
  ) {
    return "network";
  }
  if (
    normalized.includes("internal server") ||
    normalized.includes("bad gateway") ||
    normalized.includes("service unavailable")
  ) {
    return "server";
  }
  return "other";
}

/**
 * How a failed Telegram send affects the delivery's lifecycle:
 *
 * - `fail_permanently` — the chat itself is unreachable (bot blocked, chat
 *   deleted). No retry can succeed; close the log immediately.
 * - `retry_uncounted` — Telegram or the network is down, or the chat
 *   migrated and the alias awaits repair. Retry on every worker cycle
 *   without consuming the bounded retry budget.
 * - `retry_counted` — possibly message-specific (unparseable entities,
 *   unrecognized errors). Retry, but within the bounded budget so a poison
 *   message cannot retry forever.
 */
export function retryDispositionForError(
  error: string | TelegramSendFailure | null | undefined,
): RetryDisposition {
  const errorClass = classifyTelegramError(error);
  if (errorClass === "forbidden" || errorClass === "chat_not_found") return "fail_permanently";
  if (UNCOUNTED_RETRY_ERROR_CLASSES.includes(errorClass)) return "retry_uncounted";
  return "retry_counted";
}
