import { beforeEach, describe, expect, it, vi } from "vitest";

const mockLoadConfig = vi.fn();
vi.mock("../../../src/config.js", () => ({
  loadConfig: (): unknown => mockLoadConfig(),
}));

const mockFindOrganizationById = vi.fn();
vi.mock("../../../src/db/repos/organizations.js", () => ({
  findOrganizationById: (...args: unknown[]): unknown => mockFindOrganizationById(...args),
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

  it("returns null when the organization has no Stripe customer", async () => {
    mockFindOrganizationById.mockResolvedValue({ id: "org-1", stripeCustomerId: null });
    await expect(createCustomerPortalSession({} as never, "org-1")).resolves.toBeNull();
  });

  it("creates a customer portal session for linked organizations", async () => {
    mockFindOrganizationById.mockResolvedValue({ id: "org-1", stripeCustomerId: "cus_123" });
    await expect(createCustomerPortalSession({} as never, "org-1")).resolves.toBe(
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
    mockFindOrganizationById.mockResolvedValue({ id: "org-1", stripeCustomerId: "cus_123" });

    await createCustomerPortalSession({} as never, "org-1");

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

    await expect(createCustomerPortalSession({} as never, "org-1")).rejects.toThrow(
      /not configured/i,
    );
  });
});
