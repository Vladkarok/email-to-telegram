import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetPrimaryOrganizationForUser = vi.fn();
const mockReserveHostedOnboardingAttemptInTransaction = vi.fn();
const mockCreateOrganization = vi.fn();
const mockAddOrganizationMember = vi.fn();

vi.mock("../../../src/tenant/currentOrganization.js", () => ({
  getUserById: (...args: unknown[]): unknown =>
    mockGetPrimaryOrganizationForUser(...args),
}));

vi.mock("../../../src/db/repos/hostedOnboardingAttempts.js", () => ({
  reserveHostedOnboardingAttemptInTransaction: (...args: unknown[]): unknown =>
    mockReserveHostedOnboardingAttemptInTransaction(...args),
}));

vi.mock("../../../src/db/repos/organizations.js", () => ({
  createOrganization: (...args: unknown[]): unknown => mockCreateOrganization(...args),
}));

vi.mock("../../../src/db/repos/organizationMembers.js", () => ({
  addOrganizationMember: (...args: unknown[]): unknown => mockAddOrganizationMember(...args),
}));

const { HostedOnboardingRateLimitError, ensurePersonalOrganizationForUserWithOnboardingLimit } =
  await import("../../../src/abuse/hostedOnboarding.js");

const user = {
  id: 123456789n,
  username: "tester",
  isAllowed: false,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const organization = {
  id: "org-1",
  name: "Org",
  planCode: "free",
  subscriptionStatus: "free",
  stripeCustomerId: null,
  stripeSubscriptionId: null,
  trialEndsAt: null,
  currentPeriodStart: null,
  currentPeriodEnd: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe("ensurePersonalOrganizationForUserWithOnboardingLimit", () => {
  const tx = {
    execute: vi.fn().mockResolvedValue(undefined),
  };
  const db = {
    transaction: vi.fn((work: (tx: unknown) => Promise<unknown>) => work(tx)),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetPrimaryOrganizationForUser.mockResolvedValue(null);
    mockReserveHostedOnboardingAttemptInTransaction.mockResolvedValue(true);
    mockCreateOrganization.mockResolvedValue(organization);
    mockAddOrganizationMember.mockResolvedValue(undefined);
  });

  it("returns an existing organization without consuming onboarding quota", async () => {
    mockGetPrimaryOrganizationForUser.mockResolvedValue(organization);

    await expect(
      ensurePersonalOrganizationForUserWithOnboardingLimit(db as never, user),
    ).resolves.toBe(organization);

    expect(mockCreateOrganization).not.toHaveBeenCalled();
    expect(mockReserveHostedOnboardingAttemptInTransaction).not.toHaveBeenCalled();
  });

  it("reserves durable onboarding quota inside the same user lock transaction before creating a new organization", async () => {
    await expect(
      ensurePersonalOrganizationForUserWithOnboardingLimit(db as never, user),
    ).resolves.toBe(organization);

    expect(tx.execute).toHaveBeenCalledOnce();
    expect(mockGetPrimaryOrganizationForUser).toHaveBeenCalledWith(tx, user.id);
    expect(mockReserveHostedOnboardingAttemptInTransaction).toHaveBeenCalledWith(tx, user.id);
    expect(mockCreateOrganization).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        name: "@tester",
        planCode: "free",
        subscriptionStatus: "free",
      }),
    );
    expect(mockAddOrganizationMember).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        organizationId: "org-1",
        userId: user.id,
        role: "owner",
      }),
    );
  });

  it("rate limits new workspace setup when durable quota is exhausted", async () => {
    mockReserveHostedOnboardingAttemptInTransaction.mockResolvedValue(false);

    await expect(
      ensurePersonalOrganizationForUserWithOnboardingLimit(db as never, user),
    ).rejects.toBeInstanceOf(HostedOnboardingRateLimitError);
    expect(mockCreateOrganization).not.toHaveBeenCalled();
  });
});
