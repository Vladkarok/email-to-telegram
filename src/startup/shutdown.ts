import type { Logger } from "pino";

/** Docker's stop_grace_period (30 s) kills 5 s after this. */
export const SHUTDOWN_DEADLINE_MS = 25_000;
const PIPELINE_DRAIN_MS = 15_000;

export interface ShutdownSteps {
  /** Synchronous: shutdown flag, bot health, polling restart, cron schedulers, retry stop flag. */
  begin(): void;
  /** Bounce notices: stop admission, discard queued jobs, abort sends (at most 2 s). */
  stopNotices(): Promise<void>;
  closeHttp(): Promise<void>;
  /** `bot.stop()`: aborts the long poll and confirms up to the update in progress. */
  stopBot(): Promise<void>;
  /** The current `bot.start()` run: the update in progress and the gated rest of its batch. */
  pollingRun(): Promise<void>;
  /** The active retry run, which stops before its next claim. */
  retryRun(): Promise<void>;
  pipelines: { readonly inFlight: number; drain(timeoutMs: number): Promise<void> };
  destroySessionStore(): void;
  closeDb(): Promise<void>;
}

/**
 * Builds the signal handler. One deadline bounds the whole sequence: after
 * `deadlineMs` the process logs what is still pending and exits 1. Work cut
 * there stays retryable in the DB. A second signal does not restart it.
 */
export function createShutdown(
  steps: ShutdownSteps,
  {
    logger,
    exit,
    deadlineMs = SHUTDOWN_DEADLINE_MS,
  }: {
    logger: Pick<Logger, "info" | "warn" | "error">;
    exit: (code: number) => void;
    deadlineMs?: number;
  },
): (signal: string) => Promise<void> {
  let started = false;
  let exited = false;
  const finish = (code: number): void => {
    if (exited) return;
    exited = true;
    exit(code);
  };

  return async (signal: string) => {
    if (started) {
      logger.info({ signal }, "Shutdown already in progress");
      return;
    }
    started = true;
    logger.info({ signal }, "Shutting down...");

    const pending = new Set<string>();
    const track = <T>(name: string, promise: Promise<T>): Promise<T> => {
      pending.add(name);
      return promise.finally(() => pending.delete(name));
    };
    const watchdog = setTimeout(() => {
      logger.error(
        { deadlineMs, pending: [...pending], pipelinesInFlight: steps.pipelines.inFlight },
        "shutdown.deadline_exceeded",
      );
      finish(1);
    }, deadlineMs);

    try {
      // Crons stop, so no new background work starts; the active retry run
      // stops before its next claim.
      steps.begin();

      // Overlaps the HTTP close and the drains below.
      const noticesStopped = track("notices", steps.stopNotices());

      // Taken now, so a deadline hit while HTTP or bot.stop() hangs still
      // names an active polling or retry run. Awaited after both, below.
      const pollingRun = track("polling_run", steps.pollingRun());
      const retryRun = track("retry_run", steps.retryRun());
      // Marked handled; a rejection still reaches the Promise.all below.
      pollingRun.catch(() => {});
      retryRun.catch(() => {});

      // HTTP stops triggering new pipelines; bot.stop() aborts the long poll
      // and confirms up to the update in progress. A failed confirm is not
      // fatal: those updates are handled again by the next process.
      await Promise.all([
        track("http_close", steps.closeHttp()),
        track(
          "bot_stop",
          steps.stopBot().catch((err: unknown) => {
            logger.warn({ err }, "Bot stop failed; the update in progress may be handled again");
          }),
        ),
      ]);

      // Everything a handler or a run uses stays open until they are done.
      const inFlight = steps.pipelines.inFlight;
      if (inFlight > 0) logger.info({ inFlight }, "Draining in-flight pipelines...");
      await Promise.all([
        pollingRun,
        track(
          "pipeline_drain",
          steps.pipelines.drain(PIPELINE_DRAIN_MS).catch((err: unknown) => {
            logger.warn({ err }, "Pipeline drain timed out; proceeding with shutdown");
          }),
        ),
        retryRun,
      ]);
      await noticesStopped;
      steps.destroySessionStore();
      await track("db_close", steps.closeDb());
      clearTimeout(watchdog);
      logger.info("Shutdown complete.");
      finish(0);
    } catch (err: unknown) {
      clearTimeout(watchdog);
      logger.error({ err }, "Error during shutdown");
      finish(1);
    }
  };
}
