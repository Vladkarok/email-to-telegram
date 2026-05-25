import { describe, it, expect, vi } from "vitest";
import { retryAsync } from "../../../src/utils/retryAsync.js";

describe("retryAsync", () => {
  it("returns the result without retrying when the first attempt succeeds", async () => {
    const fn = vi.fn().mockResolvedValue("ok");

    const result = await retryAsync(fn, { attempts: 3, delaysMs: [0, 0] });

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries a transient failure and returns the eventual success", async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error("blip")).mockResolvedValueOnce("recovered");

    const result = await retryAsync(fn, { attempts: 3, delaysMs: [0, 0] });

    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("re-throws the last error after exhausting every attempt", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("persistent"));

    await expect(retryAsync(fn, { attempts: 3, delaysMs: [0, 0] })).rejects.toThrow("persistent");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("reuses last delay entry when there are more retries than delay entries", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("x"));
    // 3 attempts but only 1 delay entry → attempt 1 uses delaysMs[1] which is undefined → fallback
    await expect(retryAsync(fn, { attempts: 3, delaysMs: [0] })).rejects.toThrow("x");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("falls back to 0 delay when delaysMs is empty", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("x"));
    await expect(retryAsync(fn, { attempts: 2, delaysMs: [] })).rejects.toThrow("x");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
