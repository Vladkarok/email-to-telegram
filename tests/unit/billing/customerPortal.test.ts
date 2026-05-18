import { beforeEach, describe, expect, it, vi } from "vitest";

const mockLoadConfig = vi.fn();
vi.mock("../../../src/config.js", () => ({
  loadConfig: (): unknown => mockLoadConfig(),
}));

const mockFindUserById = vi.fn();
vi.mock("../../../src/db/repos/users.js", () => ({
  findUserById: (...args: unknown[]): unknown => mockFindUserById(...args),
}));

const mockCreatePortalSessionApi = vi.fn();
vi.mock("../../../src/billing/stripe.js", async () => {
  const actual = await vi.importActual("../../../src/billing/stripe.js");
  return {
    ...actual,
    getStripeClient: () => ({
      billingPortal: {
        sessions: { create: (...args: unknown[]): unknown => mockCreatePortalSessionApi(...args) },
      },
    }),
  };
});

const { createCustomerPortalSession } = await import("../../../src/billing/customerPortal.js");

describe("createCustomerPortalSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadConfig.mockReturnValue({
      billingProvider: "stripe",
      billingCancelUrl: "https://billing.example.com/return",
      publicBaseUrl: "https://mail.example.com",
    });
    mockCreatePortalSessionApi.mockResolvedValue({ url: "https://billing.stripe.test/portal" });
  });

  it("returns null when the user has no Stripe customer", async () => {
    mockFindUserById.mockResolvedValue({ id: 1n, stripeCustomerId: null });
    await expect(createCustomerPortalSession({} as never, 1n)).resolves.toBeNull();
  });

  it("creates a customer portal session for linked users", async () => {
    mockFindUserById.mockResolvedValue({ id: 1n, stripeCustomerId: "cus_123" });
    await expect(createCustomerPortalSession({} as never, 1n)).resolves.toBe(
      "https://billing.stripe.test/portal",
    );
    expect(mockCreatePortalSessionApi).toHaveBeenCalledWith(
      expect.objectContaining({ customer: "cus_123" }),
    );
  });

  it("falls back to publicBaseUrl when no billingCancelUrl is configured", async () => {
    mockLoadConfig.mockReturnValue({
      billingProvider: "stripe",
      billingCancelUrl: undefined,
      publicBaseUrl: "https://mail.example.com",
    });
    mockFindUserById.mockResolvedValue({ id: 1n, stripeCustomerId: "cus_123" });

    await createCustomerPortalSession({} as never, 1n);

    expect(mockCreatePortalSessionApi).toHaveBeenCalledWith(
      expect.objectContaining({ return_url: "https://mail.example.com" }),
    );
  });

  it("requires Stripe billing config before creating a portal session", async () => {
    mockLoadConfig.mockReturnValue({
      billingProvider: "none",
      billingCancelUrl: "https://billing.example.com/return",
      publicBaseUrl: "https://mail.example.com",
    });

    await expect(createCustomerPortalSession({} as never, 1n)).rejects.toThrow(/not configured/i);
  });
});
