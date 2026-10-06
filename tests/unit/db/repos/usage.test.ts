import { describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import {
  countUsersEverDelivered,
  decrementUserUsageMonth,
  incrementUserUsageMonth,
  usageMonthForDate,
} from "../../../../src/db/repos/usage.js";

describe("countUsersEverDelivered", () => {
  it("counts distinct users with delivered mail in any month of user_usage_months", async () => {
    const query = vi.fn(() => Promise.resolve({ rows: [["7"]], fields: [] }));
    const db = drizzle({ client: { query } as never }) as unknown as Parameters<
      typeof countUsersEverDelivered
    >[0];

    await expect(countUsersEverDelivered(db)).resolves.toBe(7);

    const [{ text }, params] = query.mock.calls[0] as unknown as [{ text: string }, unknown[]];
    expect(text).toBe(
      'select count(distinct "user_id") from "user_usage_months" where "user_usage_months"."delivered_count" > $1',
    );
    expect(params).toEqual([0]);
  });
});

describe("usageMonthForDate", () => {
  it("formats dates as UTC YYYY-MM month keys", () => {
    expect(usageMonthForDate(new Date("2026-04-25T12:30:00.000Z"))).toBe("2026-04");
  });

  it("uses UTC month boundaries", () => {
    expect(usageMonthForDate(new Date("2026-05-01T00:30:00.000+02:00"))).toBe("2026-04");
  });
});

describe("incrementUserUsageMonth", () => {
  it("rejects negative increments before touching the database", async () => {
    await expect(
      incrementUserUsageMonth({} as never, {
        userId: 1n,
        month: "2026-04",
        deliveredCount: -1,
      }),
    ).rejects.toThrow(/non-negative/i);
  });

  it("rejects negative egress increments before touching the database", async () => {
    await expect(
      incrementUserUsageMonth({} as never, {
        userId: 1n,
        month: "2026-04",
        egressBytes: -1n,
      }),
    ).rejects.toThrow(/non-negative/i);
  });

  it("rejects negative egress decrements before touching the database", async () => {
    await expect(
      decrementUserUsageMonth({} as never, {
        userId: 1n,
        month: "2026-04",
        egressBytes: -1n,
      }),
    ).rejects.toThrow(/non-negative/i);
  });
});
