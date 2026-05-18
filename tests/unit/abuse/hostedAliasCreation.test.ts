import { beforeEach, describe, expect, it, vi } from "vitest";

const mockReserveHostedRateLimitBucketsInTransaction = vi.fn();
const mockLoadConfig = vi.fn(() => ({ appMode: "hosted" }));

vi.mock("../../../src/config.js", () => ({
  loadConfig: (): unknown => mockLoadConfig(),
}));

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
    delete process.env["APP_MODE"];
    mockLoadConfig.mockReturnValue({ appMode: "hosted" });
    mockReserveHostedRateLimitBucketsInTransaction.mockResolvedValue(true);
  });

  it("does nothing in self-hosted mode", async () => {
    mockLoadConfig.mockReturnValue({ appMode: "self-hosted" });
    await reserveHostedAliasCreateAttempt({} as never, 123n);
    expect(mockReserveHostedRateLimitBucketsInTransaction).not.toHaveBeenCalled();
  });

  it("reserves the Telegram-user alias creation bucket in hosted mode", async () => {
    await reserveHostedAliasCreateAttempt({} as never, 123n, new Date("2026-04-28T12:00:00.000Z"));

    expect(mockReserveHostedRateLimitBucketsInTransaction).toHaveBeenCalledWith(
      {},
      "2026-04-28",
      expect.arrayContaining([
        expect.objectContaining({
          bucketType: "alias_create_telegram_user",
          bucketKey: "123",
        }),
      ]),
    );
  });

  it("throws when alias creation bucket is exhausted", async () => {
    mockReserveHostedRateLimitBucketsInTransaction.mockResolvedValueOnce(false);
    await expect(
      reserveHostedAliasCreateAttempt({} as never, 123n, new Date("2026-04-28T12:00:00.000Z")),
    ).rejects.toBeInstanceOf(HostedAliasCreateRateLimitError);
  });
});
