import { describe, expect, it } from "vitest";
import { hasLivePaidSubscription } from "../../../../src/db/repos/users.js";
import type { User } from "../../../../src/db/schema.js";

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 1n,
    username: null,
    locale: null,
    isAllowed: true,
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
    ...overrides,
  };
}

describe("hasLivePaidSubscription", () => {
  it("returns false for free users with no Stripe link", () => {
    expect(hasLivePaidSubscription(makeUser())).toBe(false);
  });

  it("returns false when no stripe link exists, even if status is non-terminal", () => {
    expect(hasLivePaidSubscription(makeUser({ subscriptionStatus: "active" }))).toBe(false);
  });

  it.each(["trialing", "active", "past_due", "incomplete", "unpaid", "paused"])(
    "returns true for non-terminal status=%s with stripe subscription id",
    (status) => {
      expect(
        hasLivePaidSubscription(
          makeUser({ stripeSubscriptionId: "sub_123", subscriptionStatus: status }),
        ),
      ).toBe(true);
    },
  );

  it.each(["canceled", "incomplete_expired"])(
    "returns false for terminal status=%s even with stripe id",
    (status) => {
      expect(
        hasLivePaidSubscription(
          makeUser({ stripeSubscriptionId: "sub_123", subscriptionStatus: status }),
        ),
      ).toBe(false);
    },
  );

  it("blocks deletion when a free user has a Stripe customer id from an open checkout", () => {
    expect(
      hasLivePaidSubscription(
        makeUser({ stripeCustomerId: "cus_123", subscriptionStatus: "free" }),
      ),
    ).toBe(true);
  });

  it("blocks deletion when only a stripeCustomerId exists with non-terminal status (mid-checkout)", () => {
    expect(
      hasLivePaidSubscription(
        makeUser({ stripeCustomerId: "cus_123", subscriptionStatus: "incomplete" }),
      ),
    ).toBe(true);
  });

  it("does not block when stripeCustomerId exists but status is terminal", () => {
    expect(
      hasLivePaidSubscription(
        makeUser({ stripeCustomerId: "cus_123", subscriptionStatus: "canceled" }),
      ),
    ).toBe(false);
  });
});
