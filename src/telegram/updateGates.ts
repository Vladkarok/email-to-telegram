import type { Context, MiddlewareFn, Transformer } from "grammy";
import { getLogger } from "../utils/logger.js";
import { recordBotUpdateSkipped } from "../observability/metrics.js";

/**
 * Outermost middleware: once shutdown has begun, no handler starts. The
 * update is skipped without calling `next()`. `bot.stop()` confirms only the
 * updates up to the one in progress, so the skipped rest of the batch stays
 * queued at Telegram and the next process handles it.
 */
export function admissionGate(isShuttingDown: () => boolean): MiddlewareFn<Context> {
  return async (_ctx, next) => {
    if (isShuttingDown()) return;
    await next();
  };
}

/**
 * Skips a text message older than `maxAgeS` when the bot gets it (a backlog
 * after an outage). Everything else is handled at any age: membership changes
 * and chat-migration service messages repair aliases, and callback queries
 * carry no tap time while their handlers revalidate.
 */
export function staleTextGuard(
  maxAgeS: number,
  nowMs: () => number = Date.now,
): MiddlewareFn<Context> {
  return async (ctx, next) => {
    const message = ctx.update.message;
    if (message?.text !== undefined) {
      const ageS = Math.floor(nowMs() / 1000) - message.date;
      if (ageS > maxAgeS) {
        getLogger().info(
          { updateId: ctx.update.update_id, updateType: "message", ageS },
          "telegram.update.stale_skipped",
        );
        recordBotUpdateSkipped("stale");
        return;
      }
    }
    await next();
  };
}

const CALLBACK_QUERY_TOO_OLD = /query is too old/i;

/**
 * Telegram refuses an answer to a callback query older than about 15 s. A tap
 * queued during a deploy is handled after start, so its answer is late; treat
 * that refusal as success so the handler goes on with the action itself. The
 * button's spinner stops on its own.
 */
export const tolerateLateCallbackAnswers: Transformer = async (prev, method, payload, signal) => {
  const response = await prev(method, payload, signal);
  if (
    method === "answerCallbackQuery" &&
    !response.ok &&
    response.error_code === 400 &&
    CALLBACK_QUERY_TOO_OLD.test(response.description)
  ) {
    getLogger().debug("telegram.callback_answer.too_old");
    return { ok: true, result: true } as Awaited<ReturnType<typeof prev<typeof method>>>;
  }
  return response;
};
