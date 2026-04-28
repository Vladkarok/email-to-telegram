import { describe, expect, it, vi } from "vitest";
import {
  hostedOnboardingWindowStart,
  reserveHostedOnboardingAttempt,
} from "../../../../src/db/repos/hostedOnboardingAttempts.js";

function makeDb({
  globalAttempts,
  userAttempts,
}: {
  globalAttempts?: number;
  userAttempts?: number;
}) {
  let selectCount = 0;
  const execute = vi.fn().mockResolvedValue(undefined);
  const insert = vi.fn().mockReturnValue({
    values: vi.fn().mockReturnValue({
      onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
    }),
  });
  const select = vi.fn(() => {
    selectCount += 1;
    const attempts = selectCount === 1 ? globalAttempts : userAttempts;
    return {
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(
          attempts == null
            ? []
            : [
                {
                  bucketType: selectCount === 1 ? "global" : "telegram_user",
                  bucketKey: selectCount === 1 ? "all" : "123",
                  windowStart: "2026-04-28",
                  attempts,
                  createdAt: new Date(),
                  updatedAt: new Date(),
                },
              ],
        ),
      }),
    };
  });
  const tx = { execute, select, insert };
  return {
    transaction: vi.fn((work: (tx: unknown) => Promise<unknown>) => work(tx)),
    _mocks: { execute, insert },
  } as unknown as Parameters<typeof reserveHostedOnboardingAttempt>[0] & {
    _mocks: {
      execute: ReturnType<typeof vi.fn>;
      insert: ReturnType<typeof vi.fn>;
    };
  };
}

describe("hosted onboarding attempt repo", () => {
  it("uses UTC day windows", () => {
    expect(hostedOnboardingWindowStart(new Date("2026-04-28T23:59:59.000Z"))).toBe("2026-04-28");
  });

  it("reserves global and per-user buckets when limits allow", async () => {
    const db = makeDb({ globalAttempts: 5, userAttempts: 1 });

    await expect(
      reserveHostedOnboardingAttempt(db, 123n, new Date("2026-04-28T00:00:00.000Z"), {
        globalDaily: 100,
        perTelegramUserDaily: 3,
      }),
    ).resolves.toBe(true);

    expect(db._mocks.execute).toHaveBeenCalledTimes(2);
    expect(db._mocks.insert).toHaveBeenCalledTimes(2);
  });

  it("refuses when the global daily bucket is exhausted", async () => {
    const db = makeDb({ globalAttempts: 100, userAttempts: 1 });

    await expect(
      reserveHostedOnboardingAttempt(db, 123n, new Date("2026-04-28T00:00:00.000Z"), {
        globalDaily: 100,
        perTelegramUserDaily: 3,
      }),
    ).resolves.toBe(false);

    expect(db._mocks.insert).not.toHaveBeenCalled();
  });

  it("refuses when the per-user daily bucket is exhausted", async () => {
    const db = makeDb({ globalAttempts: 5, userAttempts: 3 });

    await expect(
      reserveHostedOnboardingAttempt(db, 123n, new Date("2026-04-28T00:00:00.000Z"), {
        globalDaily: 100,
        perTelegramUserDaily: 3,
      }),
    ).resolves.toBe(false);

    expect(db._mocks.insert).not.toHaveBeenCalled();
  });
});
