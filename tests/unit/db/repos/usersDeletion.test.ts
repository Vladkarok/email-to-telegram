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

  it("returns false when no stripe subscription id is set, even if status looks active", () => {
    expect(hasLivePaidSubscription(makeUser({ subscriptionStatus: "active" }))).toBe(false);
  });

  it.each(["trialing", "active", "past_due"])(
    "returns true for status=%s with stripe subscription id",
    (status) => {
      expect(
        hasLivePaidSubscription(
          makeUser({ stripeSubscriptionId: "sub_123", subscriptionStatus: status }),
        ),
      ).toBe(true);
    },
  );

  it.each(["canceled", "unpaid", "incomplete", "incomplete_expired", "paused"])(
    "returns false for terminal/inactive status=%s even with stripe id",
    (status) => {
      expect(
        hasLivePaidSubscription(
          makeUser({ stripeSubscriptionId: "sub_123", subscriptionStatus: status }),
        ),
      ).toBe(false);
    },
  );
});
