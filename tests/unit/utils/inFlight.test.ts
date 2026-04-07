import { describe, expect, it, vi } from "vitest";
import { InFlightTracker } from "../../../src/utils/inFlight.js";

describe("InFlightTracker", () => {
  it("tracks keyed work while it is running", async () => {
    const tracker = new InFlightTracker();
    let resolveWork: (() => void) | null = null;

    const work = tracker.runFor("log-1", async () => {
      await new Promise<void>((resolve) => {
        resolveWork = resolve;
      });
    });

    expect(tracker.inFlight).toBe(1);
    expect(tracker.isActive("log-1")).toBe(true);

    resolveWork?.();
    await work;

    expect(tracker.inFlight).toBe(0);
    expect(tracker.isActive("log-1")).toBe(false);
  });

  it("drains after keyed work completes", async () => {
    const tracker = new InFlightTracker();

    await tracker.runFor("log-1", async () => {
      await Promise.resolve();
    });

    await expect(tracker.drain()).resolves.toBeUndefined();
  });

  it("keeps a key active until all overlapping keyed work finishes", async () => {
    const tracker = new InFlightTracker();
    let resolveFirst: (() => void) | null = null;
    let resolveSecond: (() => void) | null = null;

    const first = tracker.runFor("log-1", async () => {
      await new Promise<void>((resolve) => {
        resolveFirst = resolve;
      });
    });
    const second = tracker.runFor("log-1", async () => {
      await new Promise<void>((resolve) => {
        resolveSecond = resolve;
      });
    });

    expect(tracker.inFlight).toBe(2);
    expect(tracker.isActive("log-1")).toBe(true);

    resolveFirst?.();
    await first;
    expect(tracker.inFlight).toBe(1);
    expect(tracker.isActive("log-1")).toBe(true);

    resolveSecond?.();
    await second;
    expect(tracker.isActive("log-1")).toBe(false);
  });

  it("times out drain when work does not finish in time", async () => {
    vi.useFakeTimers();
    try {
      const tracker = new InFlightTracker();
      let resolveWork: (() => void) | null = null;

      const work = tracker.run(async () => {
        await new Promise<void>((resolve) => {
          resolveWork = resolve;
        });
      });
      const drain = expect(tracker.drain(50)).rejects.toThrow(/drain timed out/i);

      await vi.advanceTimersByTimeAsync(50);
      await drain;

      resolveWork?.();
      await work;
    } finally {
      vi.useRealTimers();
    }
  });
});
