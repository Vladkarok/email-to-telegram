import type { Bot } from "grammy";
import type { Logger } from "pino";
import { markBotHealthy, markBotUnhealthy } from "./health.js";
import { nextPollingStartOptions } from "../startup/runtime.js";

export interface PollingController {
  /** Starts long polling unless shutdown has begun; restarts after an error. */
  start(): Promise<void>;
  /** Cancels a restart scheduled after a polling error. */
  cancelRestart(): void;
  /**
   * Settles when the current `bot.start()` run has ended: after `bot.stop()`,
   * once the handler in progress and the rest of its batch are done. At once
   * when polling is not running.
   */
  currentRun(): Promise<void>;
}

export function createPollingController({
  bot,
  logger,
  isShuttingDown,
  syncCommands,
  restartDelayMs = 5000,
}: {
  bot: Bot;
  logger: Pick<Logger, "info" | "warn" | "error">;
  isShuttingDown: () => boolean;
  syncCommands: (bot: Bot) => Promise<void>;
  restartDelayMs?: number;
}): PollingController {
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  let isInitialPollingStart = true;
  let run: Promise<void> | null = null;

  const start = async (): Promise<void> => {
    if (isShuttingDown()) return; // guard against already-queued setTimeout callbacks
    const pollingStart = nextPollingStartOptions(isInitialPollingStart);
    isInitialPollingStart = pollingStart.nextIsInitialPollingStart;

    try {
      await bot.api.getMe();
      await syncCommands(bot).catch((err: unknown) => {
        logger.warn({ err }, "Failed to sync bot commands; will retry on next start");
      });
      const pendingUpdateCount = await bot.api.getWebhookInfo().then(
        (info) => info.pending_update_count,
        (err: unknown) => {
          logger.warn({ err }, "Failed to read the pending update count");
          return null;
        },
      );
      // Shutdown may have begun during the awaits above. No await between this
      // check and bot.start(): start() sets grammY's running flag
      // synchronously, so a shutdown that begins later finds polling running
      // and bot.stop() aborts it. Polling started after the stop would confirm
      // the updates the admission gate skips.
      if (isShuttingDown()) return;
      logger.info({ pending_update_count: pendingUpdateCount }, "telegram.polling.started");
      const current = bot.start({
        drop_pending_updates: pollingStart.dropPendingUpdates,
        // grammY runs onStart once deleteWebhook has succeeded, right before
        // the first getUpdates: healthy means polling.
        onStart: () => {
          if (!isShuttingDown()) markBotHealthy();
        },
      });
      run = current.then(
        () => undefined,
        () => undefined,
      );
      await current;
    } catch (err: unknown) {
      markBotUnhealthy();
      if (isShuttingDown()) return;
      logger.error({ err }, "Bot polling error — restarting in 5s");
      restartTimer = setTimeout(() => {
        restartTimer = null;
        void start();
      }, restartDelayMs);
    }
  };

  return {
    start,
    cancelRestart() {
      if (restartTimer) {
        clearTimeout(restartTimer);
        restartTimer = null;
      }
    },
    currentRun() {
      return run ?? Promise.resolve();
    },
  };
}
