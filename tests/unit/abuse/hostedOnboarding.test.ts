import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetPrimaryOrganizationForUser = vi.fn();
const mockEnsurePersonalOrganizationForUser = vi.fn();
const mockReserveHostedOnboardingAttempt = vi.fn();

vi.mock("../../../src/tenant/currentOrganization.js", () => ({
  getPrimaryOrganizationForUser: (...args: unknown[]): unknown =>
    mockGetPrimaryOrganizationForUser(...args),
  ensurePersonalOrganizationForUser: (...args: unknown[]): unknown =>
    mockEnsurePersonalOrganizationForUser(...args),
}));

vi.mock("../../../src/db/repos/hostedOnboardingAttempts.js", () => ({
  reserveHostedOnboardingAttempt: (...args: unknown[]): unknown =>
    mockReserveHostedOnboardingAttempt(...args),
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
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetPrimaryOrganizationForUser.mockResolvedValue(null);
    mockEnsurePersonalOrganizationForUser.mockResolvedValue(organization);
    mockReserveHostedOnboardingAttempt.mockResolvedValue(true);
  });

  it("returns an existing organization without consuming onboarding quota", async () => {
    mockGetPrimaryOrganizationForUser.mockResolvedValue(organization);

    await expect(
      ensurePersonalOrganizationForUserWithOnboardingLimit({} as never, user),
    ).resolves.toBe(organization);

    expect(mockEnsurePersonalOrganizationForUser).not.toHaveBeenCalled();
    expect(mockReserveHostedOnboardingAttempt).not.toHaveBeenCalled();
  });

  it("reserves durable onboarding quota before creating a new organization", async () => {
    await expect(
      ensurePersonalOrganizationForUserWithOnboardingLimit({} as never, user),
    ).resolves.toBe(organization);

    expect(mockReserveHostedOnboardingAttempt).toHaveBeenCalledWith({} as never, user.id);
    expect(mockEnsurePersonalOrganizationForUser).toHaveBeenCalled();
  });

  it("rate limits new workspace setup when durable quota is exhausted", async () => {
    mockReserveHostedOnboardingAttempt.mockResolvedValue(false);

    await expect(
      ensurePersonalOrganizationForUserWithOnboardingLimit({} as never, user),
    ).rejects.toBeInstanceOf(HostedOnboardingRateLimitError);
    expect(mockEnsurePersonalOrganizationForUser).not.toHaveBeenCalled();
  });
});
