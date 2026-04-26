import { describe, expect, it } from "vitest";
import {
  decrementOrganizationUsageMonth,
  incrementOrganizationUsageMonth,
  usageMonthForDate,
} from "../../../../src/db/repos/usage.js";

describe("usageMonthForDate", () => {
  it("formats dates as UTC YYYY-MM month keys", () => {
    expect(usageMonthForDate(new Date("2026-04-25T12:30:00.000Z"))).toBe("2026-04");
  });

  it("uses UTC month boundaries", () => {
    expect(usageMonthForDate(new Date("2026-05-01T00:30:00.000+02:00"))).toBe("2026-04");
  });
});

describe("incrementOrganizationUsageMonth", () => {
  it("rejects negative increments before touching the database", async () => {
    await expect(
      incrementOrganizationUsageMonth({} as never, {
        organizationId: "org-1",
        month: "2026-04",
        deliveredCount: -1,
      }),
    ).rejects.toThrow(/non-negative/i);
  });

  it("rejects negative egress increments before touching the database", async () => {
    await expect(
      incrementOrganizationUsageMonth({} as never, {
        organizationId: "org-1",
        month: "2026-04",
        egressBytes: -1n,
      }),
    ).rejects.toThrow(/non-negative/i);
  });

  it("rejects negative egress decrements before touching the database", async () => {
    await expect(
      decrementOrganizationUsageMonth({} as never, {
        organizationId: "org-1",
        month: "2026-04",
        egressBytes: -1n,
      }),
    ).rejects.toThrow(/non-negative/i);
  });
});
