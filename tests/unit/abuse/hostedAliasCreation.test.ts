import { beforeEach, describe, expect, it, vi } from "vitest";

const mockReserveHostedRateLimitBucketsInTransaction = vi.fn();

vi.mock("../../../src/db/repos/hostedOnboardingAttempts.js", () => ({
  hostedOnboardingWindowStart: (date = new Date()): string => date.toISOString().slice(0, 10),
  reserveHostedRateLimitBucketsInTransaction: (...args: unknown[]): unknown =>
    mockReserveHostedRateLimitBucketsInTransaction(...args),
}));

const { HostedAliasCreateRateLimitError, reserveHostedAliasCreateAttempt } =
  await import("../../../src/abuse/hostedAliasCreation.js");

describe("reserveHostedAliasCreateAttempt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReserveHostedRateLimitBucketsInTransaction.mockResolvedValue(true);
  });

  it("does nothing for self-hosted aliases without an organization", async () => {
    await reserveHostedAliasCreateAttempt({} as never, null, 123n);

    expect(mockReserveHostedRateLimitBucketsInTransaction).not.toHaveBeenCalled();
  });

  it("reserves org and Telegram-user alias creation buckets", async () => {
    await reserveHostedAliasCreateAttempt(
      {} as never,
      "org-1",
      123n,
      new Date("2026-04-28T12:00:00.000Z"),
    );

    expect(mockReserveHostedRateLimitBucketsInTransaction).toHaveBeenCalledWith(
      {},
      "2026-04-28",
      expect.arrayContaining([
        expect.objectContaining({ bucketType: "alias_create_org", bucketKey: "org-1" }),
        expect.objectContaining({
          bucketType: "alias_create_telegram_user",
          bucketKey: "123",
        }),
      ]),
    );
  });

  it("throws when alias creation buckets are exhausted", async () => {
    mockReserveHostedRateLimitBucketsInTransaction.mockResolvedValue(false);

    await expect(
      reserveHostedAliasCreateAttempt({} as never, "org-1", 123n),
    ).rejects.toBeInstanceOf(HostedAliasCreateRateLimitError);
  });
});
