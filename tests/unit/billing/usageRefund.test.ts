import { beforeEach, describe, expect, it, vi } from "vitest";
import { refundAcceptedEmail } from "../../../src/billing/usageRefund.js";

const mockDecrementUserUsageMonth = vi.fn();

vi.mock("../../../src/db/repos/usage.js", async () => {
  const actual = await vi.importActual<typeof import("../../../src/db/repos/usage.js")>(
    "../../../src/db/repos/usage.js",
  );
  return {
    ...actual,
    decrementUserUsageMonth: (...args: unknown[]): unknown => mockDecrementUserUsageMonth(...args),
  };
});

describe("refundAcceptedEmail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDecrementUserUsageMonth.mockResolvedValue({});
  });

  it("refunds one delivered_count in the month the email was accepted", async () => {
    await refundAcceptedEmail({} as never, {
      deliveryLogId: "log-1",
      userId: 42n,
      receivedAt: new Date("2026-07-15T10:00:00.000Z"),
    });

    expect(mockDecrementUserUsageMonth).toHaveBeenCalledOnce();
    expect(mockDecrementUserUsageMonth).toHaveBeenCalledWith(expect.anything(), {
      userId: 42n,
      month: "2026-07",
      deliveredCount: 1,
    });
  });

  it("targets the acceptance month across a UTC month boundary", async () => {
    // Accepted June 30, permanently failed after retries in July: the June
    // counter was charged, so June gets the refund.
    await refundAcceptedEmail({} as never, {
      deliveryLogId: "log-2",
      userId: 42n,
      receivedAt: new Date("2026-06-30T23:50:00.000Z"),
    });

    expect(mockDecrementUserUsageMonth).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ month: "2026-06" }),
    );
  });

  it("never throws when the decrement fails", async () => {
    mockDecrementUserUsageMonth.mockRejectedValue(new Error("no row returned"));
    await expect(
      refundAcceptedEmail({} as never, {
        deliveryLogId: "log-3",
        userId: 42n,
        receivedAt: new Date("2026-07-15T10:00:00.000Z"),
      }),
    ).resolves.toBeUndefined();
  });
});
