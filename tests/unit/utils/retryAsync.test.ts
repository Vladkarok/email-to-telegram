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
});
