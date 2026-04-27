import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig, StripePriceIds } from "../../../src/config.js";

const mockLoadConfig = vi.fn();
vi.mock("../../../src/config.js", () => ({
  loadConfig: (): unknown => mockLoadConfig(),
}));

const {
  constructWebhookEvent,
  getStripeClient,
  isStripePriceKey,
  resolvePlanFromStripePriceId,
  resolveStripePrice,
} = await import("../../../src/billing/stripe.js");

describe("billing stripe helpers", () => {
  const stripePriceIds: StripePriceIds = {
    personalMonthly: "price_personal_monthly",
    personalYearly: "price_personal_yearly",
    proMonthly: "price_pro_monthly",
    proYearly: "price_pro_yearly",
    teamMonthly: "price_team_monthly",
    teamYearly: "price_team_yearly",
  };
  const config = {
    billingProvider: "stripe",
    stripeSecretKey: "sk_test_example",
    stripeWebhookSecret: "whsec_example",
    stripePriceIds,
  } as Pick<
    AppConfig,
    "billingProvider" | "stripeSecretKey" | "stripeWebhookSecret" | "stripePriceIds"
  >;

  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadConfig.mockReturnValue(config);
  });

  it("recognizes supported Stripe price keys", () => {
    expect(isStripePriceKey("team_yearly")).toBe(true);
    expect(isStripePriceKey("free_monthly")).toBe(false);
  });

  it("resolves checkout price metadata from configured price ids", () => {
    expect(resolveStripePrice(stripePriceIds, "pro_monthly")).toMatchObject({
      priceId: "price_pro_monthly",
      planCode: "pro",
      billingInterval: "monthly",
    });
  });

  it("maps Stripe price ids back to plan metadata", () => {
    expect(resolvePlanFromStripePriceId(config, "price_team_yearly")).toMatchObject({
      planCode: "team",
      billingInterval: "yearly",
    });
    expect(resolvePlanFromStripePriceId(config, "price_unknown")).toBeNull();
  });

  it("requires Stripe billing config before creating a client", () => {
    expect(() =>
      getStripeClient({ billingProvider: "none", stripeSecretKey: undefined } as never),
    ).toThrow(/not configured/i);
  });

  it("returns the cached Stripe client for the same secret key", () => {
    const first = getStripeClient(config as never);
    const second = getStripeClient(config as never);

    expect(second).toBe(first);
  });

  it("requires a configured webhook secret before constructing events", () => {
    expect(() =>
      constructWebhookEvent(Buffer.from("{}"), "sig", {
        billingProvider: "stripe",
        stripeSecretKey: "sk_test_example",
        stripeWebhookSecret: undefined,
      } as never),
    ).toThrow(/not configured/i);
  });

  it("returns null when the Stripe price lookup input is missing", () => {
    expect(resolvePlanFromStripePriceId({ stripePriceIds: stripePriceIds }, null)).toBeNull();
    expect(
      resolvePlanFromStripePriceId({ stripePriceIds: undefined }, "price_team_yearly"),
    ).toBeNull();
  });
});
