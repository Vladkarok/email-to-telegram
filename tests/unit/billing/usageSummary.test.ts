import { describe, it, expect } from "vitest";
import {
  formatBytes,
  formatBytesQuota,
  formatCountQuota,
  buildPlanSummaryText,
  buildUsageSummaryText,
} from "../../../src/billing/usageSummary.js";
import { getPlanDefinition } from "../../../src/billing/plans.js";

describe("formatBytes", () => {
  it("formats zero as '0 B'", () => {
    expect(formatBytes(0n)).toBe("0 B");
  });

  it("formats sub-KB as bytes", () => {
    expect(formatBytes(512n)).toBe("512 B");
  });

  it("formats KiB rounded to one decimal", () => {
    expect(formatBytes(1536n)).toBe("1.5 KB");
  });

  it("formats MiB rounded to one decimal", () => {
    expect(formatBytes(5n * 1024n * 1024n)).toBe("5.0 MB");
  });

  it("formats GiB rounded to one decimal", () => {
    expect(formatBytes(2n * 1024n * 1024n * 1024n)).toBe("2.0 GB");
  });
});

describe("formatBytesQuota", () => {
  it("renders used/total with percent", () => {
    const text = formatBytesQuota(50n * 1024n * 1024n, 100n * 1024n * 1024n);
    expect(text).toContain("50.0 MB");
    expect(text).toContain("100.0 MB");
    expect(text).toContain("50%");
  });

  it("clamps percent display at 100%+ when over limit", () => {
    const text = formatBytesQuota(200n, 100n);
    expect(text).toContain("100%+");
  });

  it("renders 0% when used is zero", () => {
    expect(formatBytesQuota(0n, 100n)).toContain("0%");
  });

  it("renders consistent 0 B / limit (0%) for negative used bytes", () => {
    const text = formatBytesQuota(-1n, 100n);
    expect(text).toContain("0 B");
    expect(text).toContain("0%");
    expect(text).not.toContain("-");
  });
});

describe("formatCountQuota", () => {
  it("renders used/total with percent", () => {
    expect(formatCountQuota(2, 10)).toBe("2 / 10 (20%)");
  });

  it("renders 0% when used is zero", () => {
    expect(formatCountQuota(0, 10)).toBe("0 / 10 (0%)");
  });

  it("clamps percent at 100%+ when over limit", () => {
    expect(formatCountQuota(15, 10)).toBe("15 / 10 (100%+)");
  });

  it("handles zero limit defensively", () => {
    expect(formatCountQuota(0, 0)).toBe("0 / 0 (—)");
  });
});

describe("buildPlanSummaryText", () => {
  const freePlan = getPlanDefinition("free");
  const proPlan = getPlanDefinition("pro");

  it("renders plan name and free status", () => {
    const text = buildPlanSummaryText({
      plan: freePlan,
      user: {
        planCode: "free",
        subscriptionStatus: "free",
        currentPeriodEnd: null,
      },
    });
    expect(text).toContain("Free");
    expect(text).toMatch(/Status[^\n]*free/i);
    expect(text).toContain("3"); // alias limit
    expect(text).toContain("100"); // emails/month
  });

  it("renders pro plan with active status", () => {
    const text = buildPlanSummaryText({
      plan: proPlan,
      user: {
        planCode: "pro",
        subscriptionStatus: "active",
        currentPeriodEnd: new Date("2030-01-01T00:00:00Z"),
      },
    });
    expect(text).toContain("Pro");
    expect(text).toMatch(/Status[^\n]*active/i);
    expect(text).toContain("50"); // alias limit
  });

  it("flags past_due explicitly", () => {
    const text = buildPlanSummaryText({
      plan: proPlan,
      user: {
        planCode: "pro",
        subscriptionStatus: "past_due",
        currentPeriodEnd: new Date("2030-01-01T00:00:00Z"),
      },
    });
    expect(text).toMatch(/past_?due/i);
  });
});

describe("buildUsageSummaryText", () => {
  const freePlan = getPlanDefinition("free");

  const baseCounters = {
    acceptedBillable: 0,
    rejected: 0,
    telegramDelivered: 0,
    telegramFailed: 0,
    telegramPending: 0,
  };

  it("shows accepted, rejected, telegram delivered, telegram failed, pending counts separately", () => {
    const text = buildUsageSummaryText({
      plan: freePlan,
      month: "2026-04",
      counters: {
        acceptedBillable: 12,
        rejected: 3,
        telegramDelivered: 11,
        telegramFailed: 1,
        telegramPending: 2,
      },
      egressBytes: 0n,
      storageBytes: 0n,
      aliasesUsed: 1,
      allowRulesUsed: 2,
    });
    expect(text).toMatch(/Accepted[^\n]*12/);
    expect(text).toMatch(/Rejected[^\n]*3/);
    expect(text).toMatch(/Delivered to Telegram[^\n]*11/);
    expect(text).toMatch(/Telegram delivery failures[^\n]*1/);
    expect(text).toMatch(/Pending[^\n]*2/i);
  });

  it("includes a note that failed/pending Telegram deliveries are still billed", () => {
    const text = buildUsageSummaryText({
      plan: freePlan,
      month: "2026-04",
      counters: {
        acceptedBillable: 5,
        rejected: 0,
        telegramDelivered: 3,
        telegramFailed: 1,
        telegramPending: 1,
      },
      egressBytes: 0n,
      storageBytes: 0n,
      aliasesUsed: 0,
      allowRulesUsed: 0,
    });
    expect(text).toMatch(/billed|count(ed)? toward/i);
  });

  it("renders egress and storage with quota percentages", () => {
    const text = buildUsageSummaryText({
      plan: freePlan,
      month: "2026-04",
      counters: { ...baseCounters },
      egressBytes: 100n * 1024n * 1024n,
      storageBytes: 50n * 1024n * 1024n,
      aliasesUsed: 0,
      allowRulesUsed: 0,
    });
    expect(text).toMatch(/Egress/);
    expect(text).toMatch(/Storage/);
    expect(text).toMatch(/MB/);
  });

  it("renders alias and allow-rule quotas", () => {
    const text = buildUsageSummaryText({
      plan: freePlan,
      month: "2026-04",
      counters: { ...baseCounters },
      egressBytes: 0n,
      storageBytes: 0n,
      aliasesUsed: 2,
      allowRulesUsed: 4,
    });
    expect(text).toMatch(/Aliases[^\n]*2 \/ 3/);
    expect(text).toMatch(/Allow rules[^\n]*4 \/ 10/);
  });

  it("shows the month being reported", () => {
    const text = buildUsageSummaryText({
      plan: freePlan,
      month: "2026-04",
      counters: { ...baseCounters },
      egressBytes: 0n,
      storageBytes: 0n,
      aliasesUsed: 0,
      allowRulesUsed: 0,
    });
    expect(text).toContain("2026-04");
  });

  it("labels the plan limit as 'Accepted emails / month' matching billable counter terminology", () => {
    const text = buildPlanSummaryText({
      plan: freePlan,
      user: { planCode: "free", subscriptionStatus: "free", currentPeriodEnd: null },
    });
    expect(text).toMatch(/Accepted emails \/ month/);
  });
});
