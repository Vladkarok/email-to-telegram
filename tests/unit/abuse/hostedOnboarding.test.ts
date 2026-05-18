import { beforeEach, describe, expect, it, vi } from "vitest";

const mockReserveHostedOnboardingAttemptInTransaction = vi.fn();
const mockFindUserById = vi.fn();
const mockUpsertUser = vi.fn();

vi.mock("../../../src/db/repos/hostedOnboardingAttempts.js", () => ({
  reserveHostedOnboardingAttemptInTransaction: (...args: unknown[]): unknown =>
    mockReserveHostedOnboardingAttemptInTransaction(...args),
}));

vi.mock("../../../src/db/repos/users.js", () => ({
  findUserById: (...args: unknown[]): unknown => mockFindUserById(...args),
  upsertUser: (...args: unknown[]): unknown => mockUpsertUser(...args),
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
    mockFindUserById.mockResolvedValue(null);
    mockUpsertUser.mockResolvedValue(USER);
  });

  it("reserves the onboarding bucket for a new user and returns the upserted user", async () => {
    const db = fakeDb();
    const result = await ensureUserWithOnboardingLimit(db as never, USER);

    expect(result).toEqual(USER);
    expect(mockReserveHostedOnboardingAttemptInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      12345n,
    );
    expect(mockUpsertUser).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: 12345n, username: "alice" }),
    );
  });

  it("does not reserve onboarding bucket for an existing user", async () => {
    mockFindUserById.mockResolvedValueOnce(USER);
    const db = fakeDb();
    const result = await ensureUserWithOnboardingLimit(db as never, USER);

    expect(result).toEqual(USER);
    expect(mockReserveHostedOnboardingAttemptInTransaction).not.toHaveBeenCalled();
    expect(mockUpsertUser).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: 12345n, username: "alice" }),
    );
  });

  it("throws HostedOnboardingRateLimitError when the bucket is exhausted", async () => {
    mockReserveHostedOnboardingAttemptInTransaction.mockResolvedValueOnce(false);
    const db = fakeDb();
    await expect(ensureUserWithOnboardingLimit(db as never, USER)).rejects.toBeInstanceOf(
      HostedOnboardingRateLimitError,
    );
    expect(mockUpsertUser).not.toHaveBeenCalled();
  });
});
