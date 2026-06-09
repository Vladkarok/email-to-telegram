/**
 * Coarse classification of Telegram/grammY send errors, shared by
 * observability (metric labels) and the delivery retry policy.
 *
 * Classification works on normalized error strings because grammY surfaces
 * Bot API failures as messages like
 * "Call to 'sendMessage' failed! (403: Forbidden: bot was blocked by the user)"
 * and network failures as HttpError/fetch messages.
 */

export type TelegramErrorClass =
  | "flood_wait"
  | "forbidden"
  | "chat_not_found"
  | "bad_request"
  | "timeout"
  | "network"
  | "server"
  | "other"
  | "unknown";

export type RetryDisposition = "fail_permanently" | "retry_uncounted" | "retry_counted";

/**
 * Error classes that do not consume the per-email retry budget: they signal
 * Telegram (or the path to it) being unavailable, not this message or chat
 * being undeliverable. Affected deliveries stay retryable until their raw
 * email TTL expires.
 */
export const UNCOUNTED_RETRY_ERROR_CLASSES: readonly TelegramErrorClass[] = [
  "flood_wait",
  "timeout",
  "network",
  "server",
];

export function classifyTelegramError(error: string | null | undefined): TelegramErrorClass {
  const normalized = (error ?? "").toLowerCase();
  if (!normalized) return "unknown";
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
 * - `retry_uncounted` — Telegram or the network is down. Retry on every
 *   worker cycle without consuming the bounded retry budget.
 * - `retry_counted` — possibly message-specific (unparseable entities,
 *   unrecognized errors). Retry, but within the bounded budget so a poison
 *   message cannot retry forever.
 */
export function retryDispositionForError(error: string | null | undefined): RetryDisposition {
  const errorClass = classifyTelegramError(error);
  if (errorClass === "forbidden" || errorClass === "chat_not_found") return "fail_permanently";
  if (UNCOUNTED_RETRY_ERROR_CLASSES.includes(errorClass)) return "retry_uncounted";
  return "retry_counted";
}
