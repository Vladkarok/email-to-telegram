import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ActivationNoticeQueue,
  type ActivationNoticeJob,
  type ActivationNoticeRequest,
  type NoticeJobContext,
  type NoticeRunner,
} from "../../../src/activation/noticeQueue.js";
import { NOTICE_BOUNDS, type NoticeBounds } from "../../../src/activation/bounds.js";
import { metricsRegistry, resetMetricsForTests } from "../../../src/observability/metrics.js";

vi.mock("../../../src/utils/logger.js", () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

function request(overrides: Partial<ActivationNoticeRequest> = {}): ActivationNoticeRequest {
  return {
    stage: "raw",
    aliasId: "11111111-1111-4111-8111-111111111111",
    headerFromDomain: "github.com",
    envelopeFrom: "bounce@github.com",
    rawMime: Buffer.alloc(100),
    ...overrides,
  };
}

function bounds(overrides: Partial<NoticeBounds> = {}): NoticeBounds {
  return { ...NOTICE_BOUNDS, ...overrides };
}

/** A promise with its resolver, for holding jobs open. */
function gate<T = void>() {
  let release!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function noticeCount(stage: string, result: string): Promise<number> {
  const text = await metricsRegistry.getSingleMetricAsString(
    "email_to_telegram_activation_notices_total",
  );
  const line = text
    .split("\n")
    .find((l) => l.includes(`stage="${stage}"`) && l.includes(`result="${result}"`));
  return Number(line?.split(" ").pop() ?? NaN);
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("ActivationNoticeQueue", () => {
  beforeEach(() => {
    resetMetricsForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("admits without running anything synchronously and copies only the job's fields", async () => {
    const seen: ActivationNoticeJob[] = [];
    const runner = vi.fn<NoticeRunner>((job) => {
      seen.push(job);
      return Promise.resolve("sent");
    });
    const queue = new ActivationNoticeQueue(runner);
    const req = { ...request(), extra: "not copied" } as ActivationNoticeRequest;

    expect(queue.admit(req)).toBe(true);
    expect(runner).not.toHaveBeenCalled();
    expect(queue.admitted).toBe(1);
    await queue.whenIdle();

    expect(runner).toHaveBeenCalledTimes(1);
    expect(Object.keys(seen[0]).sort()).toEqual(
      ["admittedAt", "aliasId", "envelopeFrom", "headerFromDomain", "mime", "stage"].sort(),
    );
    expect(seen[0].mime).toBe(req.rawMime);
    expect(queue.admitted).toBe(0);
    expect(await noticeCount("raw", "sent")).toBe(1);
  });

  it("never throws from admit, even when its input is hostile", () => {
    const queue = new ActivationNoticeQueue(() => Promise.resolve("sent"));
    const hostile = {
      get stage(): never {
        throw new Error("boom");
      },
    } as unknown as ActivationNoticeRequest;
    expect(() => queue.admit(hostile)).not.toThrow();
    expect(queue.admit(hostile)).toBe(false);
  });

  it("admits at most 8 jobs, counted until each settles, and drops the rest", async () => {
    const hold = gate();
    const queue = new ActivationNoticeQueue(async () => {
      await hold.promise;
      return "sent";
    });
    for (let i = 0; i < 8; i++) expect(queue.admit(request())).toBe(true);
    expect(queue.admit(request())).toBe(false);
    expect(queue.admitted).toBe(8);
    expect(await noticeCount("raw", "dropped")).toBe(1);

    hold.release();
    await queue.whenIdle();
    expect(queue.admitted).toBe(0);
    expect(queue.admit(request())).toBe(true);
    await queue.whenIdle();
  });

  it("keeps a slot taken past the deadline until the job's promise settles", async () => {
    const hold = gate();
    const queue = new ActivationNoticeQueue(
      async () => {
        await hold.promise;
        return "sent";
      },
      bounds({ maxAdmittedJobs: 1, jobDeadlineMs: 1 }),
    );
    queue.admit(request());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(queue.admit(request())).toBe(false);
    hold.release();
    await queue.whenIdle();
    expect(queue.admit(request())).toBe(true);
    await queue.whenIdle();
  });

  it("holds at most 4 MiB of MIME; a larger message is admitted without it", async () => {
    const hold = gate();
    const jobs: ActivationNoticeJob[] = [];
    const queue = new ActivationNoticeQueue(async (job) => {
      jobs.push(job);
      await hold.promise;
      return "sent";
    });
    const threeMiB = Buffer.alloc(3 * 1024 * 1024);
    const twoMiB = Buffer.alloc(2 * 1024 * 1024);
    const oneMiB = Buffer.alloc(1024 * 1024);
    const tooBig = Buffer.alloc(4 * 1024 * 1024 + 1);

    queue.admit(request({ rawMime: threeMiB }));
    queue.admit(request({ rawMime: twoMiB })); // would exceed: no MIME
    queue.admit(request({ rawMime: oneMiB })); // fits exactly: 4 MiB
    queue.admit(request({ rawMime: tooBig })); // never fits
    expect(queue.heldMimeBytes).toBe(4 * 1024 * 1024);
    await tick();
    await tick();

    expect(jobs.map((job) => job.mime?.length ?? null)).toEqual([
      threeMiB.length,
      null,
      oneMiB.length,
      null,
    ]);
    hold.release();
    await queue.whenIdle();
    expect(queue.heldMimeBytes).toBe(0);
  });

  it("does not hold MIME for a job without a From domain to authenticate", async () => {
    const jobs: ActivationNoticeJob[] = [];
    const queue = new ActivationNoticeQueue((job) => {
      jobs.push(job);
      return Promise.resolve("sent");
    });
    queue.admit(request({ headerFromDomain: null }));
    expect(queue.heldMimeBytes).toBe(0);
    await queue.whenIdle();
    expect(jobs[0].mime).toBeNull();
  });

  it("releases the MIME budget on every exit: result, error, stop", async () => {
    const runners: NoticeRunner[] = [
      () => Promise.resolve("failed"),
      () => Promise.reject(new Error("boom")),
      (_job, ctx) => {
        ctx.beginPhase();
        return Promise.resolve("sent");
      },
    ];
    for (const runner of runners) {
      const queue = new ActivationNoticeQueue(runner, bounds({ jobDeadlineMs: 0 }));
      queue.admit(request());
      expect(queue.heldMimeBytes).toBe(100);
      await queue.whenIdle();
      expect(queue.heldMimeBytes).toBe(0);
    }
    expect(await noticeCount("raw", "failed")).toBe(2);
    expect(await noticeCount("raw", "dropped")).toBe(1);
  });

  it("drops a job that starts more than 60 s after admission", async () => {
    let now = 1_000;
    const runner = vi.fn<NoticeRunner>(() => Promise.resolve("sent"));
    const queue = new ActivationNoticeQueue(runner, NOTICE_BOUNDS, () => now);
    queue.admit(request());
    now += 60_001;
    await queue.whenIdle();
    expect(runner).not.toHaveBeenCalled();
    expect(await noticeCount("raw", "dropped")).toBe(1);
  });

  it("starts no phase after the 20 s deadline", async () => {
    let now = 0;
    const phases: string[] = [];
    const queue = new ActivationNoticeQueue(
      (_job, ctx) => {
        ctx.beginPhase();
        phases.push("claim");
        now += 20_000;
        ctx.beginPhase();
        phases.push("send");
        return Promise.resolve("sent");
      },
      NOTICE_BOUNDS,
      () => now,
    );
    queue.admit(request());
    await queue.whenIdle();
    expect(phases).toEqual(["claim"]);
    expect(await noticeCount("raw", "dropped")).toBe(1);
  });

  describe("authentication slots", () => {
    it("runs at most 2 authentications at once", async () => {
      const holds = Array.from({ length: 4 }, () => gate<string>());
      let running = 0;
      let peak = 0;
      let started = 0;
      const queue = new ActivationNoticeQueue(async (_job, ctx) => {
        const index = started++;
        const outcome = await ctx.authenticate(async () => {
          running += 1;
          peak = Math.max(peak, running);
          const value = await holds[index].promise;
          running -= 1;
          return value;
        });
        return outcome.ok ? "sent" : "failed";
      });
      for (let i = 0; i < 4; i++) queue.admit(request());
      await tick();
      await tick();
      expect(queue.runningAuthentications).toBe(2);
      for (const hold of holds) hold.release("ok");
      await queue.whenIdle();
      expect(peak).toBe(2);
      expect(await noticeCount("raw", "sent")).toBe(4);
    });

    it("gives up waiting after the budget and still sends, without the result", async () => {
      const hold = gate<string>();
      const outcomes: unknown[] = [];
      const queue = new ActivationNoticeQueue(
        async (_job, ctx) => {
          outcomes.push(await ctx.authenticate(() => hold.promise));
          return "sent";
        },
        bounds({ maxConcurrentAuthentications: 1, authenticationBudgetMs: 30 }),
      );
      queue.admit(request());
      queue.admit(request());
      await new Promise((resolve) => setTimeout(resolve, 80));
      // Both jobs gave up: one waited for the slot, one waited for the result.
      expect(outcomes).toEqual([
        { ok: false, reason: "budget" },
        { ok: false, reason: "budget" },
      ]);
      // The running authentication keeps its slot, and its job stays admitted.
      expect(queue.runningAuthentications).toBe(1);
      expect(queue.admitted).toBe(1);
      expect(queue.heldMimeBytes).toBe(100);
      hold.release("late");
      await queue.whenIdle();
      expect(queue.runningAuthentications).toBe(0);
      expect(queue.heldMimeBytes).toBe(0);
    });

    it("reports a failing authentication as an error, not a throw", async () => {
      let outcome: unknown;
      const queue = new ActivationNoticeQueue(async (_job, ctx) => {
        outcome = await ctx.authenticate(() => Promise.reject(new Error("dns")));
        return "sent";
      });
      queue.admit(request());
      await queue.whenIdle();
      expect(outcome).toEqual({ ok: false, reason: "error" });
      expect(queue.runningAuthentications).toBe(0);
    });
  });

  describe("shutdown", () => {
    it("stops admission, discards jobs that have not started, aborts sends, waits at most 2 s", async () => {
      const started = gate();
      let sendSignal: AbortSignal | null = null;
      const runner = vi.fn<NoticeRunner>(async (_job, ctx: NoticeJobContext) => {
        ctx.beginPhase();
        started.release();
        await ctx.withSendSignal(
          (signal) =>
            new Promise((_, reject) => {
              sendSignal = signal;
              signal.addEventListener("abort", () => reject(new Error("aborted")));
            }),
        );
        return "sent";
      });
      const queue = new ActivationNoticeQueue(runner, bounds({ shutdownWaitMs: 2_000 }));
      queue.admit(request());
      await started.promise;
      queue.admit(request()); // admitted, not started yet

      const before = Date.now();
      await queue.shutdown();
      expect(Date.now() - before).toBeLessThan(500);
      expect(sendSignal!.aborted).toBe(true);
      expect(runner).toHaveBeenCalledTimes(1);
      expect(queue.admit(request())).toBe(false);
      await queue.whenIdle();
      expect(await noticeCount("raw", "failed")).toBe(1);
      expect(await noticeCount("raw", "dropped")).toBe(2);
    });

    it("lets no running job start a new phase", async () => {
      const hold = gate();
      const phases: string[] = [];
      const queue = new ActivationNoticeQueue(async (_job, ctx) => {
        ctx.beginPhase();
        phases.push("claim");
        await hold.promise;
        ctx.beginPhase();
        phases.push("send");
        return "sent";
      });
      queue.admit(request());
      await tick();
      const stopped = queue.shutdown();
      hold.release();
      await stopped;
      expect(phases).toEqual(["claim"]);
    });

    it("abandons authentication waits on shutdown", async () => {
      const hold = gate<string>();
      const outcomes: unknown[] = [];
      const queue = new ActivationNoticeQueue(
        async (_job, ctx) => {
          outcomes.push(await ctx.authenticate(() => hold.promise));
          return "sent";
        },
        bounds({ maxConcurrentAuthentications: 1 }),
      );
      queue.admit(request());
      queue.admit(request());
      await tick();
      await tick();
      const stopped = queue.shutdown(50);
      await stopped;
      expect(outcomes).toEqual([
        { ok: false, reason: "stopped" },
        { ok: false, reason: "stopped" },
      ]);
      hold.release("late");
      await queue.whenIdle();
    });

    it("returns after the wait bound even when a job never settles", async () => {
      const queue = new ActivationNoticeQueue(
        () => new Promise(() => {}),
        bounds({ shutdownWaitMs: 60 }),
      );
      queue.admit(request());
      await tick();
      const before = Date.now();
      await queue.shutdown();
      const elapsed = Date.now() - before;
      expect(elapsed).toBeGreaterThanOrEqual(50);
      expect(elapsed).toBeLessThan(500);
    });

    it("returns at once with nothing admitted", async () => {
      const queue = new ActivationNoticeQueue(() => Promise.resolve("sent"));
      await expect(queue.shutdown()).resolves.toBeUndefined();
      expect(queue.isClosed).toBe(true);
    });
  });

  it("aborts a Telegram send that runs past its timeout", async () => {
    let aborted = false;
    const queue = new ActivationNoticeQueue(
      async (_job, ctx) => {
        await ctx
          .withSendSignal(
            (signal) =>
              new Promise((_, reject) => {
                signal.addEventListener("abort", () => {
                  aborted = true;
                  reject(new Error("aborted"));
                });
              }),
          )
          .catch(() => undefined);
        return "failed";
      },
      bounds({ telegramSendTimeoutMs: 20 }),
    );
    queue.admit(request());
    await queue.whenIdle();
    expect(aborted).toBe(true);
  });
});
