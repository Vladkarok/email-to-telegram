import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createShutdown,
  SHUTDOWN_DEADLINE_MS,
  type ShutdownSteps,
} from "../../../src/startup/shutdown.js";
import { InFlightTracker } from "../../../src/utils/inFlight.js";

const never = () => new Promise<void>(() => {});

function setup(overrides: Partial<ShutdownSteps> = {}) {
  const events: string[] = [];
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const exit = vi.fn((code: number) => {
    events.push(`exit:${code}`);
  });
  const steps: ShutdownSteps = {
    begin: () => events.push("begin"),
    stopNotices: () => Promise.resolve(),
    closeHttp: () => Promise.resolve(),
    stopBot: () => Promise.resolve(),
    pollingRun: () => Promise.resolve(),
    retryRun: () => Promise.resolve(),
    pipelines: new InFlightTracker(),
    destroySessionStore: () => events.push("session_store"),
    closeDb: () => {
      events.push("db_closed");
      return Promise.resolve();
    },
    ...overrides,
  };
  const shutdown = createShutdown(steps, { logger, exit });
  return { shutdown, events, logger, exit };
}

describe("createShutdown", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("has a 25-s deadline, 5 s inside Docker's 30-s grace period", () => {
    expect(SHUTDOWN_DEADLINE_MS).toBe(25_000);
  });

  it("closes the DB last and exits 0", async () => {
    const { shutdown, events, exit } = setup();

    await shutdown("SIGTERM");

    expect(events).toEqual(["begin", "session_store", "db_closed", "exit:0"]);
    expect(exit).toHaveBeenCalledOnce();
  });

  it.each([
    ["a request that never ends", { closeHttp: never }, "http_close", 1],
    ["a Telegram call that never returns", { stopBot: never }, "bot_stop", 1],
    ["a pool.end() that never resolves", { closeDb: never }, "db_close", 1],
  ] as const)(
    "exits 1 at 25 s with %s and logs what is pending",
    async (_name, overrides, pendingStep, deliveries) => {
      const pipelines = new InFlightTracker();
      const delivery = deliveries > 0 ? pipelines.run(never) : undefined;
      const { shutdown, logger, exit } = setup({ ...overrides, pipelines });

      void shutdown("SIGTERM");
      await vi.advanceTimersByTimeAsync(24_999);
      expect(exit).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(exit).toHaveBeenCalledExactlyOnceWith(1);
      const [fields, message] = logger.error.mock.calls[0] as [
        { pending: string[]; pipelinesInFlight: number },
        string,
      ];
      expect(message).toBe("shutdown.deadline_exceeded");
      expect(fields.pending).toContain(pendingStep);
      expect(fields.pipelinesInFlight).toBe(deliveries);
      void delivery;
    },
  );

  it("waits for the polling run, the pipeline drain and the retry run before closing the DB", async () => {
    let finishPolling!: () => void;
    let finishRetry!: () => void;
    const pipelines = new InFlightTracker();
    let finishDelivery!: () => void;
    void pipelines.run(
      () =>
        new Promise<void>((resolve) => {
          finishDelivery = resolve;
        }),
    );
    const { shutdown, events } = setup({
      pipelines,
      pollingRun: () =>
        new Promise<void>((resolve) => {
          finishPolling = () => {
            events.push("polling_done");
            resolve();
          };
        }),
      retryRun: () =>
        new Promise<void>((resolve) => {
          finishRetry = () => {
            events.push("retry_done");
            resolve();
          };
        }),
    });

    const done = shutdown("SIGTERM");
    await vi.advanceTimersByTimeAsync(1_000);
    finishPolling();
    await vi.advanceTimersByTimeAsync(1_000);
    finishRetry();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(events).toEqual(["begin", "polling_done", "retry_done"]);
    finishDelivery();
    await done;

    expect(events).toEqual([
      "begin",
      "polling_done",
      "retry_done",
      "session_store",
      "db_closed",
      "exit:0",
    ]);
  });

  it("names an active polling run and retry run when HTTP close never ends", async () => {
    const { shutdown, logger, exit } = setup({
      closeHttp: never,
      pollingRun: never,
      retryRun: never,
    });

    void shutdown("SIGTERM");
    await vi.advanceTimersByTimeAsync(SHUTDOWN_DEADLINE_MS);

    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    const [fields, message] = logger.error.mock.calls[0] as [{ pending: string[] }, string];
    expect(message).toBe("shutdown.deadline_exceeded");
    expect(fields.pending).toEqual(
      expect.arrayContaining(["http_close", "polling_run", "retry_run"]),
    );
  });

  it("takes the polling run when shutdown begins and still closes the DB after HTTP close", async () => {
    const order: string[] = [];
    let finishHttp!: () => void;
    const { shutdown, events } = setup({
      closeHttp: () =>
        new Promise<void>((resolve) => {
          finishHttp = () => {
            order.push("http_closed");
            resolve();
          };
        }),
      pollingRun: () => {
        order.push("polling_run_taken");
        return Promise.resolve();
      },
    });

    const done = shutdown("SIGTERM");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(events).toEqual(["begin"]);
    finishHttp();
    await done;

    expect(order).toEqual(["polling_run_taken", "http_closed"]);
    expect(events).toEqual(["begin", "session_store", "db_closed", "exit:0"]);
  });

  it("goes on with the drain when bot.stop() fails", async () => {
    const { shutdown, events, logger } = setup({
      stopBot: () => Promise.reject(new Error("network")),
    });

    await shutdown("SIGTERM");

    expect(events).toEqual(["begin", "session_store", "db_closed", "exit:0"]);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("ignores a second signal", async () => {
    const begin = vi.fn();
    const { shutdown, exit } = setup({ begin, closeHttp: never });

    void shutdown("SIGTERM");
    void shutdown("SIGINT");
    await vi.advanceTimersByTimeAsync(SHUTDOWN_DEADLINE_MS);

    expect(begin).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });
});
