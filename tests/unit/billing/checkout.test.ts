import { beforeEach, describe, expect, it, vi } from "vitest";

const mockLoadConfig = vi.fn();
vi.mock("../../../src/config.js", () => ({
  loadConfig: (): unknown => mockLoadConfig(),
}));

const mockFindOrganizationById = vi.fn();
const mockUpdateOrganizationBillingState = vi.fn();
vi.mock("../../../src/db/repos/organizations.js", () => ({
  findOrganizationById: (...args: unknown[]): unknown => mockFindOrganizationById(...args),
  updateOrganizationBillingState: (...args: unknown[]): unknown =>
    mockUpdateOrganizationBillingState(...args),
}));

const mockCreateCustomer = vi.fn();
const mockCreateCheckoutSessionApi = vi.fn();
vi.mock("../../../src/billing/stripe.js", async () => {
  const actual = await vi.importActual("../../../src/billing/stripe.js");
  return {
    ...actual,
    getStripeClient: () => ({
      customers: { create: (...args: unknown[]): unknown => mockCreateCustomer(...args) },
      checkout: {
        sessions: {
          create: (...args: unknown[]): unknown => mockCreateCheckoutSessionApi(...args),
        },
      },
    }),
  };
});

const { BillingCheckoutConflictError, createCheckoutSession } =
  await import("../../../src/billing/checkout.js");

describe("createCheckoutSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadConfig.mockReturnValue({
      billingProvider: "stripe",
      stripePriceIds: {
        personalMonthly: "price_personal_monthly",
        personalYearly: "price_personal_yearly",
        proMonthly: "price_pro_monthly",
        proYearly: "price_pro_yearly",
        teamMonthly: "price_team_monthly",
        teamYearly: "price_team_yearly",
      },
      billingSuccessUrl: "https://billing.example.com/success",
      billingCancelUrl: "https://billing.example.com/cancel",
    });
    mockCreateCheckoutSessionApi.mockResolvedValue({ url: "https://checkout.stripe.test/session" });
  });

  it("creates a customer first when the organization is not yet linked", async () => {
    mockFindOrganizationById.mockResolvedValue({
      id: "org-1",
      name: "Org One",
      stripeCustomerId: null,
    });
    mockCreateCustomer.mockResolvedValue({ id: "cus_123" });

    await expect(createCheckoutSession({} as never, "org-1", "pro_monthly")).resolves.toBe(
      "https://checkout.stripe.test/session",
    );

    expect(mockUpdateOrganizationBillingState).toHaveBeenCalledWith(expect.anything(), "org-1", {
      stripeCustomerId: "cus_123",
    });
  });

  it("reuses an existing customer when the organization is already linked", async () => {
    mockFindOrganizationById.mockResolvedValue({
      id: "org-1",
      name: "Org One",
      stripeCustomerId: "cus_existing",
    });

    await createCheckoutSession({} as never, "org-1", "pro_monthly");

    expect(mockCreateCustomer).not.toHaveBeenCalled();
    expect(mockCreateCheckoutSessionApi).toHaveBeenCalledWith(
      expect.objectContaining({ customer: "cus_existing" }),
    );
  });

  it("rejects duplicate checkout for an organization with an active Stripe subscription", async () => {
    mockFindOrganizationById.mockResolvedValue({
      id: "org-1",
      name: "Org One",
      stripeCustomerId: "cus_existing",
      stripeSubscriptionId: "sub_existing",
      subscriptionStatus: "active",
    });

    await expect(createCheckoutSession({} as never, "org-1", "pro_monthly")).rejects.toBeInstanceOf(
      BillingCheckoutConflictError,
    );

    expect(mockCreateCheckoutSessionApi).not.toHaveBeenCalled();
  });
});
