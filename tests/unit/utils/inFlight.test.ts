import { describe, expect, it } from "vitest";
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
});
