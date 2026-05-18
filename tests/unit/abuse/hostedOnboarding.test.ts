import { beforeEach, describe, expect, it, vi } from "vitest";

const mockReserveHostedOnboardingAttemptInTransaction = vi.fn();
const mockFindOrCreateUserById = vi.fn();

vi.mock("../../../src/db/repos/hostedOnboardingAttempts.js", () => ({
  reserveHostedOnboardingAttemptInTransaction: (...args: unknown[]): unknown =>
    mockReserveHostedOnboardingAttemptInTransaction(...args),
}));

vi.mock("../../../src/db/repos/users.js", () => ({
  findOrCreateUserById: (...args: unknown[]): unknown => mockFindOrCreateUserById(...args),
}));

const { HostedOnboardingRateLimitError, ensureUserWithOnboardingLimit } =
  await import("../../../src/abuse/hostedOnboarding.js");

function fakeDb() {
  const tx = { execute: vi.fn().mockResolvedValue(undefined) };
  return {
    transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work(tx)),
    execute: vi.fn().mockResolvedValue(undefined),
  };
}

const USER = {
  id: 12345n,
  username: "alice",
  locale: null,
  isAllowed: false,
  planCode: "free",
  subscriptionStatus: "free",
  stripeCustomerId: null,
  stripeSubscriptionId: null,
  trialEndsAt: null,
  currentPeriodStart: null,
  currentPeriodEnd: null,
  paidThroughAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe("ensureUserWithOnboardingLimit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReserveHostedOnboardingAttemptInTransaction.mockResolvedValue(true);
    mockFindOrCreateUserById.mockResolvedValue(USER);
  });

  it("reserves the onboarding bucket and returns the upserted user", async () => {
    const db = fakeDb();
    const result = await ensureUserWithOnboardingLimit(db as never, USER);

    expect(result).toEqual(USER);
    expect(mockReserveHostedOnboardingAttemptInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      12345n,
    );
    expect(mockFindOrCreateUserById).toHaveBeenCalledWith(expect.anything(), 12345n);
  });

  it("throws HostedOnboardingRateLimitError when the bucket is exhausted", async () => {
    mockReserveHostedOnboardingAttemptInTransaction.mockResolvedValueOnce(false);
    const db = fakeDb();
    await expect(ensureUserWithOnboardingLimit(db as never, USER)).rejects.toBeInstanceOf(
      HostedOnboardingRateLimitError,
    );
    expect(mockFindOrCreateUserById).not.toHaveBeenCalled();
  });
});
