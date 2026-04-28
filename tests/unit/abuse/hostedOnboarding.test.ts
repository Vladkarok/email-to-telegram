import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetPrimaryOrganizationForUser = vi.fn();
const mockEnsurePersonalOrganizationForUser = vi.fn();

vi.mock("../../../src/tenant/currentOrganization.js", () => ({
  getPrimaryOrganizationForUser: (...args: unknown[]): unknown =>
    mockGetPrimaryOrganizationForUser(...args),
  ensurePersonalOrganizationForUser: (...args: unknown[]): unknown =>
    mockEnsurePersonalOrganizationForUser(...args),
}));

const {
  HostedOnboardingRateLimitError,
  ensurePersonalOrganizationForUserWithOnboardingLimit,
  resetHostedOnboardingLimiterForTests,
} = await import("../../../src/abuse/hostedOnboarding.js");

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
    resetHostedOnboardingLimiterForTests();
    mockGetPrimaryOrganizationForUser.mockResolvedValue(null);
    mockEnsurePersonalOrganizationForUser.mockResolvedValue(organization);
  });

  it("returns an existing organization without consuming onboarding quota", async () => {
    mockGetPrimaryOrganizationForUser.mockResolvedValue(organization);

    await expect(
      ensurePersonalOrganizationForUserWithOnboardingLimit({} as never, user),
    ).resolves.toBe(organization);

    expect(mockEnsurePersonalOrganizationForUser).not.toHaveBeenCalled();
  });

  it("rate limits repeated new workspace setup attempts for the same Telegram user", async () => {
    await ensurePersonalOrganizationForUserWithOnboardingLimit({} as never, user);
    await ensurePersonalOrganizationForUserWithOnboardingLimit({} as never, user);
    await ensurePersonalOrganizationForUserWithOnboardingLimit({} as never, user);

    await expect(
      ensurePersonalOrganizationForUserWithOnboardingLimit({} as never, user),
    ).rejects.toBeInstanceOf(HostedOnboardingRateLimitError);
  });
});
