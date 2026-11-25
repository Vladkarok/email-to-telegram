/**
 * The step order of the egress charge without a database: the limit is
 * checked before the claim, and nothing is counted on a refusal. The locking
 * and rollback are covered on Postgres in tests/db/egressCharge.pg.test.ts,
 * which is skipped when TEST_DATABASE_URL is unset.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const steps: string[] = [];
const mockCheckEgressLimit = vi.fn();
const mockIncrementUserUsageMonth = vi.fn();

vi.mock("../../../src/billing/limits.js", () => ({
  checkEgressLimit: (...args: unknown[]): unknown => {
    steps.push("check");
    return mockCheckEgressLimit(...args);
  },
  withUserQuotaLock: (db: unknown, _owner: unknown, fn: (tx: unknown) => Promise<unknown>) =>
    fn(db),
}));
vi.mock("../../../src/db/repos/usage.js", () => ({
  usageMonthForDate: () => "2026-01",
  incrementUserUsageMonth: (...args: unknown[]): unknown => {
    steps.push("count");
    return mockIncrementUserUsageMonth(...args);
  },
}));

const { chargeEgress } = await import("../../../src/billing/egressCharge.js");

const DB = {} as Parameters<typeof chargeEgress>[0];

function charge(claimed: boolean) {
  return chargeEgress(DB, {
    ownerUserId: 5n,
    onRefusal: "rollback",
    prepare: () => {
      steps.push("prepare");
      return Promise.resolve({ egressBytes: 10n, value: "page" });
    },
    claim: () => {
      steps.push("claim");
      return Promise.resolve(claimed);
    },
  });
}

describe("chargeEgress step order", () => {
  beforeEach(() => {
    steps.length = 0;
    vi.clearAllMocks();
    mockCheckEgressLimit.mockResolvedValue({ ok: true });
    mockIncrementUserUsageMonth.mockResolvedValue(undefined);
  });

  it("prepares, checks, claims, then counts", async () => {
    const result = await charge(true);

    expect(result.status).toBe("charged");
    expect(steps).toEqual(["prepare", "check", "claim", "count"]);
    expect(mockCheckEgressLimit).toHaveBeenCalledWith(DB, 5n, 10n, "2026-01");
    expect(mockIncrementUserUsageMonth).toHaveBeenCalledWith(DB, {
      userId: 5n,
      month: "2026-01",
      egressBytes: 10n,
    });
  });

  it("over the limit neither claims nor counts", async () => {
    mockCheckEgressLimit.mockResolvedValue({ ok: false, code: "egress_limit" });

    const result = await charge(true);

    expect(result.status).toBe("over_limit");
    expect(steps).toEqual(["prepare", "check"]);
  });

  it("a lost claim counts nothing", async () => {
    const result = await charge(false);

    expect(result).toEqual({ status: "claim_lost", month: "2026-01" });
    expect(steps).toEqual(["prepare", "check", "claim"]);
  });
});
