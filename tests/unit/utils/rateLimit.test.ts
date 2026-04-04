import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RateLimiter } from "../../../src/utils/rateLimit.js";

describe("RateLimiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows requests below the limit", () => {
    const limiter = new RateLimiter(5, 60 * 60 * 1000); // 5 per hour
    for (let i = 0; i < 5; i++) {
      expect(limiter.check("key1")).toBe(true);
    }
  });

  it("blocks when limit is exceeded", () => {
    const limiter = new RateLimiter(3, 60 * 60 * 1000);
    limiter.check("key1");
    limiter.check("key1");
    limiter.check("key1");
    expect(limiter.check("key1")).toBe(false);
  });

  it("allows again after window expires", () => {
    const limiter = new RateLimiter(2, 1000); // 2 per second
    limiter.check("key1");
    limiter.check("key1");
    expect(limiter.check("key1")).toBe(false);

    vi.advanceTimersByTime(1001); // advance past window
    expect(limiter.check("key1")).toBe(true);
  });

  it("tracks different keys independently", () => {
    const limiter = new RateLimiter(2, 60 * 60 * 1000);
    limiter.check("key1");
    limiter.check("key1");
    expect(limiter.check("key1")).toBe(false);
    // key2 is independent
    expect(limiter.check("key2")).toBe(true);
    expect(limiter.check("key2")).toBe(true);
  });

  it("sliding window: old entries drop out as time passes", () => {
    const limiter = new RateLimiter(3, 60_000); // 3 per minute
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    limiter.check("k");
    limiter.check("k");
    limiter.check("k");
    expect(limiter.check("k")).toBe(false);

    // Advance 30s — entries are still within 60s window
    vi.advanceTimersByTime(30_000);
    expect(limiter.check("k")).toBe(false);

    // Advance another 31s — first 3 entries are now >60s old
    vi.advanceTimersByTime(31_000);
    expect(limiter.check("k")).toBe(true);
  });
});
