import { beforeEach, describe, expect, it, vi } from "vitest";

const mockLoadConfig = vi.fn();
vi.mock("../../../src/config.js", () => ({
  loadConfig: (): unknown => mockLoadConfig(),
}));

const mockFindUserByIdForUpdate = vi.fn();
const mockUpdateUserBillingState = vi.fn();
vi.mock("../../../src/db/repos/users.js", () => ({
  findUserByIdForUpdate: (...args: unknown[]): unknown => mockFindUserByIdForUpdate(...args),
  updateUserBillingState: (...args: unknown[]): unknown => mockUpdateUserBillingState(...args),
}));

interface MockTx {
  execute: (...args: unknown[]) => Promise<void>;
}
function makeDb(): { transaction: (fn: (tx: MockTx) => Promise<unknown>) => Promise<unknown> } {
  return {
    transaction: async (fn) => fn({ execute: () => Promise.resolve() }),
  };
}

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

  it("creates a customer first when the user is not yet linked", async () => {
    mockFindUserByIdForUpdate.mockResolvedValue({
      id: 1n,
      username: "alice",
      stripeCustomerId: null,
    });
    mockCreateCustomer.mockResolvedValue({ id: "cus_123" });

    await expect(createCheckoutSession(makeDb() as never, 1n, "pro_monthly")).resolves.toBe(
      "https://checkout.stripe.test/session",
    );

    expect(mockUpdateUserBillingState).toHaveBeenCalledWith(expect.anything(), 1n, {
      stripeCustomerId: "cus_123",
    });
  });

  it("reuses an existing customer when the user is already linked", async () => {
    mockFindUserByIdForUpdate.mockResolvedValue({
      id: 1n,
      username: "alice",
      stripeCustomerId: "cus_existing",
    });

    await createCheckoutSession(makeDb() as never, 1n, "pro_monthly");

    expect(mockCreateCustomer).not.toHaveBeenCalled();
    expect(mockCreateCheckoutSessionApi).toHaveBeenCalledWith(
      expect.objectContaining({ customer: "cus_existing" }),
    );
  });

  it("rejects duplicate checkout for a user with an active Stripe subscription", async () => {
    mockFindUserByIdForUpdate.mockResolvedValue({
      id: 1n,
      username: "alice",
      stripeCustomerId: "cus_existing",
      stripeSubscriptionId: "sub_existing",
      subscriptionStatus: "active",
    });

    await expect(
      createCheckoutSession(makeDb() as never, 1n, "pro_monthly"),
    ).rejects.toBeInstanceOf(BillingCheckoutConflictError);

    expect(mockCreateCheckoutSessionApi).not.toHaveBeenCalled();
  });
});
