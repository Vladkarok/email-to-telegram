import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRecordBillingWebhookEvent = vi.fn();
vi.mock("../../../src/db/repos/billingWebhookEvents.js", () => ({
  recordBillingWebhookEvent: (...args: unknown[]): unknown =>
    mockRecordBillingWebhookEvent(...args),
}));

const mockFindOrganizationById = vi.fn();
const mockFindOrganizationByStripeCustomerId = vi.fn();
const mockFindOrganizationByStripeSubscriptionId = vi.fn();
const mockUpdateOrganizationBillingState = vi.fn();
const mockUpdateOrganizationPaidThroughAtIfLater = vi.fn();
vi.mock("../../../src/db/repos/organizations.js", () => ({
  findOrganizationById: (...args: unknown[]): unknown => mockFindOrganizationById(...args),
  findOrganizationByStripeCustomerId: (...args: unknown[]): unknown =>
    mockFindOrganizationByStripeCustomerId(...args),
  findOrganizationByStripeSubscriptionId: (...args: unknown[]): unknown =>
    mockFindOrganizationByStripeSubscriptionId(...args),
  updateOrganizationBillingState: (...args: unknown[]): unknown =>
    mockUpdateOrganizationBillingState(...args),
  updateOrganizationPaidThroughAtIfLater: (...args: unknown[]): unknown =>
    mockUpdateOrganizationPaidThroughAtIfLater(...args),
}));

const mockLoadConfig = vi.fn();
vi.mock("../../../src/config.js", () => ({
  loadConfig: (): unknown => mockLoadConfig(),
}));

const { processStripeWebhookEvent } = await import("../../../src/billing/webhooks.js");

describe("processStripeWebhookEvent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRecordBillingWebhookEvent.mockResolvedValue(true);
    mockLoadConfig.mockReturnValue({
      stripePriceIds: {
        personalMonthly: "price_personal_monthly",
        personalYearly: "price_personal_yearly",
        proMonthly: "price_pro_monthly",
        proYearly: "price_pro_yearly",
        teamMonthly: "price_team_monthly",
        teamYearly: "price_team_yearly",
      },
    });
  });

  function buildDb() {
    return {
      transaction: async <T>(callback: (tx: unknown) => Promise<T>) => callback({}),
    } as never;
  }

  it("ignores duplicate webhook deliveries", async () => {
    mockRecordBillingWebhookEvent.mockResolvedValue(false);

    await expect(
      processStripeWebhookEvent(buildDb(), {
        id: "evt_dup",
        type: "customer.subscription.updated",
        data: { object: {} },
      } as never),
    ).resolves.toBe("duplicate");
  });

  it("updates organization billing state from a mapped subscription price", async () => {
    mockFindOrganizationByStripeSubscriptionId.mockResolvedValue({
      id: "org-1",
      planCode: "free",
      stripeCustomerId: null,
      stripeSubscriptionId: null,
    });

    await expect(
      processStripeWebhookEvent(buildDb(), {
        id: "evt_sub",
        type: "customer.subscription.updated",
        data: {
          object: {
            id: "sub_123",
            customer: "cus_123",
            metadata: { organizationId: "org-1" },
            status: "active",
            trial_end: null,
            items: {
              data: [
                {
                  price: { id: "price_pro_monthly" },
                  current_period_start: 1_700_000_000,
                  current_period_end: 1_700_086_400,
                },
              ],
            },
          },
        },
      } as never),
    ).resolves.toBe("processed");

    expect(mockUpdateOrganizationBillingState).toHaveBeenCalledWith(
      expect.anything(),
      "org-1",
      expect.objectContaining({
        planCode: "pro",
        subscriptionStatus: "active",
        stripeCustomerId: "cus_123",
        stripeSubscriptionId: "sub_123",
      }),
    );
  });

  it("ignores subscription updates whose price id is not mapped", async () => {
    mockFindOrganizationByStripeSubscriptionId.mockResolvedValue({
      id: "org-1",
      planCode: "free",
      stripeCustomerId: null,
      stripeSubscriptionId: null,
    });

    await expect(
      processStripeWebhookEvent(buildDb(), {
        id: "evt_unknown_price",
        type: "customer.subscription.updated",
        data: {
          object: {
            id: "sub_123",
            customer: "cus_123",
            metadata: { organizationId: "org-1" },
            status: "active",
            trial_end: null,
            items: { data: [{ price: { id: "price_unknown" } }] },
          },
        },
      } as never),
    ).resolves.toBe("ignored");

    expect(mockUpdateOrganizationBillingState).not.toHaveBeenCalled();
  });

  it("does not overwrite unrelated manual business organizations", async () => {
    mockFindOrganizationById.mockResolvedValue({
      id: "org-business",
      planCode: "business",
      stripeCustomerId: null,
      stripeSubscriptionId: null,
    });

    await expect(
      processStripeWebhookEvent(buildDb(), {
        id: "evt_checkout",
        type: "checkout.session.completed",
        data: {
          object: {
            customer: "cus_accidental",
            metadata: { organizationId: "org-business" },
            client_reference_id: "org-business",
          },
        },
      } as never),
    ).resolves.toBe("ignored");

    expect(mockUpdateOrganizationBillingState).not.toHaveBeenCalled();
  });

  it("does not overwrite unlinked manual paid organizations resolved by metadata", async () => {
    mockFindOrganizationByStripeSubscriptionId.mockResolvedValue(null);
    mockFindOrganizationByStripeCustomerId.mockResolvedValue(null);
    mockFindOrganizationById.mockResolvedValue({
      id: "org-manual",
      planCode: "pro",
      subscriptionStatus: "active",
      stripeCustomerId: null,
      stripeSubscriptionId: null,
    });

    await expect(
      processStripeWebhookEvent(buildDb(), {
        id: "evt_stale_manual_subscription",
        type: "customer.subscription.deleted",
        data: {
          object: {
            id: "sub_old",
            customer: "cus_old",
            metadata: { organizationId: "org-manual" },
            status: "canceled",
            trial_end: null,
            items: {
              data: [
                {
                  price: { id: "price_pro_monthly" },
                  current_period_start: 1_700_000_000,
                  current_period_end: 1_700_086_400,
                },
              ],
            },
          },
        },
      } as never),
    ).resolves.toBe("ignored");

    expect(mockUpdateOrganizationBillingState).not.toHaveBeenCalled();
  });

  it("processes checkout completion by linking the Stripe customer", async () => {
    mockFindOrganizationById.mockResolvedValue({
      id: "org-1",
      planCode: "free",
      stripeCustomerId: null,
      stripeSubscriptionId: null,
    });

    await expect(
      processStripeWebhookEvent(buildDb(), {
        id: "evt_checkout_success",
        type: "checkout.session.completed",
        data: {
          object: {
            customer: "cus_123",
            metadata: { organizationId: "org-1" },
            client_reference_id: "org-1",
          },
        },
      } as never),
    ).resolves.toBe("processed");

    expect(mockUpdateOrganizationBillingState).toHaveBeenCalledWith(expect.anything(), "org-1", {
      stripeCustomerId: "cus_123",
    });
  });

  it("ignores checkout completion when the organization cannot be resolved", async () => {
    mockFindOrganizationById.mockResolvedValue(null);

    await expect(
      processStripeWebhookEvent(buildDb(), {
        id: "evt_checkout_missing_org",
        type: "checkout.session.completed",
        data: {
          object: {
            customer: "cus_123",
            metadata: { organizationId: "org-missing" },
            client_reference_id: "org-missing",
          },
        },
      } as never),
    ).resolves.toBe("ignored");

    expect(mockUpdateOrganizationBillingState).not.toHaveBeenCalled();
  });

  it("allows retry after a failed state update instead of treating the event as durable", async () => {
    mockFindOrganizationByStripeSubscriptionId.mockResolvedValue({
      id: "org-1",
      planCode: "free",
      stripeCustomerId: null,
      stripeSubscriptionId: null,
    });
    mockRecordBillingWebhookEvent.mockResolvedValue(true);
    mockUpdateOrganizationBillingState
      .mockRejectedValueOnce(new Error("write failed"))
      .mockResolvedValueOnce({});

    const event = {
      id: "evt_retryable",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_123",
          customer: "cus_123",
          metadata: { organizationId: "org-1" },
          status: "active",
          trial_end: null,
          items: {
            data: [
              {
                price: { id: "price_pro_monthly" },
                current_period_start: 1_700_000_000,
                current_period_end: 1_700_086_400,
              },
            ],
          },
        },
      },
    } as never;

    await expect(processStripeWebhookEvent(buildDb(), event)).rejects.toThrow("write failed");
    await expect(processStripeWebhookEvent(buildDb(), event)).resolves.toBe("processed");
    expect(mockRecordBillingWebhookEvent).toHaveBeenCalledTimes(2);
  });

  it("records paid-through time from successful invoice payments without clobbering plan state", async () => {
    mockFindOrganizationByStripeSubscriptionId.mockResolvedValue({
      id: "org-1",
      planCode: "pro",
      stripeCustomerId: "cus_123",
      stripeSubscriptionId: "sub_123",
      paidThroughAt: null,
    });

    await expect(
      processStripeWebhookEvent(buildDb(), {
        id: "evt_invoice_paid",
        type: "invoice.payment_succeeded",
        data: {
          object: {
            customer: "cus_123",
            parent: {
              subscription_details: {
                metadata: { organizationId: "org-1" },
                subscription: "sub_123",
              },
            },
            lines: {
              data: [
                {
                  parent: {
                    subscription_item_details: {
                      subscription: "sub_123",
                    },
                  },
                  period: { end: 1_700_086_400 },
                },
              ],
            },
          },
        },
      } as never),
    ).resolves.toBe("processed");

    expect(mockUpdateOrganizationPaidThroughAtIfLater).toHaveBeenCalledWith(
      expect.anything(),
      "org-1",
      new Date(1_700_086_400 * 1000),
    );
  });

  it("uses the latest subscription service-period line for paid-through time", async () => {
    mockFindOrganizationByStripeSubscriptionId.mockResolvedValue({
      id: "org-1",
      planCode: "pro",
      stripeCustomerId: "cus_123",
      stripeSubscriptionId: "sub_123",
      paidThroughAt: null,
    });

    await expect(
      processStripeWebhookEvent(buildDb(), {
        id: "evt_invoice_paid_lines",
        type: "invoice.payment_succeeded",
        data: {
          object: {
            customer: "cus_123",
            parent: {
              subscription_details: {
                metadata: { organizationId: "org-1" },
                subscription: "sub_123",
              },
            },
            lines: {
              data: [
                {
                  type: "invoiceitem",
                  subscription: "sub_123",
                  period: { end: 1_700_259_200 },
                },
                {
                  parent: {
                    subscription_item_details: {
                      subscription: "sub_123",
                    },
                  },
                  period: { end: 1_700_086_400 },
                },
                {
                  parent: {
                    subscription_item_details: {
                      subscription: "sub_123",
                    },
                  },
                  period: { end: 1_700_172_800 },
                },
              ],
            },
          },
        },
      } as never),
    ).resolves.toBe("processed");

    expect(mockUpdateOrganizationPaidThroughAtIfLater).toHaveBeenCalledWith(
      expect.anything(),
      "org-1",
      new Date(1_700_172_800 * 1000),
    );
  });

  it("delegates paid-through monotonicity to the organization repo", async () => {
    mockFindOrganizationByStripeSubscriptionId.mockResolvedValue({
      id: "org-1",
      planCode: "pro",
      stripeCustomerId: "cus_123",
      stripeSubscriptionId: "sub_123",
      paidThroughAt: new Date(1_700_172_800 * 1000),
    });

    await expect(
      processStripeWebhookEvent(buildDb(), {
        id: "evt_invoice_paid_monotonic",
        type: "invoice.payment_succeeded",
        data: {
          object: {
            customer: "cus_123",
            parent: {
              subscription_details: {
                metadata: { organizationId: "org-1" },
                subscription: "sub_123",
              },
            },
            lines: {
              data: [
                {
                  parent: {
                    subscription_item_details: {
                      subscription: "sub_123",
                    },
                  },
                  period: { end: 1_700_086_400 },
                },
              ],
            },
          },
        },
      } as never),
    ).resolves.toBe("processed");

    expect(mockUpdateOrganizationPaidThroughAtIfLater).toHaveBeenCalledWith(
      expect.anything(),
      "org-1",
      new Date(1_700_086_400 * 1000),
    );
  });

  it("ignores failed invoice payments so they cannot clobber subscription state", async () => {
    mockFindOrganizationByStripeSubscriptionId.mockResolvedValue({
      id: "org-1",
      planCode: "pro",
      stripeCustomerId: "cus_123",
      stripeSubscriptionId: "sub_123",
      paidThroughAt: null,
    });

    await expect(
      processStripeWebhookEvent(buildDb(), {
        id: "evt_invoice_failed",
        type: "invoice.payment_failed",
        data: {
          object: {
            customer: "cus_123",
            parent: {
              subscription_details: {
                metadata: { organizationId: "org-1" },
                subscription: "sub_123",
              },
            },
          },
        },
      } as never),
    ).resolves.toBe("ignored");

    expect(mockUpdateOrganizationBillingState).not.toHaveBeenCalled();
  });

  it("ignores stale subscription updates for a different subscription on the same customer", async () => {
    mockFindOrganizationByStripeSubscriptionId.mockResolvedValue(null);
    mockFindOrganizationByStripeCustomerId.mockResolvedValue({
      id: "org-1",
      planCode: "pro",
      subscriptionStatus: "active",
      stripeCustomerId: "cus_123",
      stripeSubscriptionId: "sub_current",
    });

    await expect(
      processStripeWebhookEvent(buildDb(), {
        id: "evt_stale_subscription",
        type: "customer.subscription.deleted",
        data: {
          object: {
            id: "sub_old",
            customer: "cus_123",
            metadata: { organizationId: "org-1" },
            status: "canceled",
            trial_end: null,
            items: {
              data: [
                {
                  price: { id: "price_pro_monthly" },
                  current_period_start: 1_700_000_000,
                  current_period_end: 1_700_086_400,
                },
              ],
            },
          },
        },
      } as never),
    ).resolves.toBe("ignored");

    expect(mockUpdateOrganizationBillingState).not.toHaveBeenCalled();
  });

  it("allows a new subscription.created event to replace a terminal prior subscription", async () => {
    mockFindOrganizationByStripeSubscriptionId.mockResolvedValue(null);
    mockFindOrganizationByStripeCustomerId.mockResolvedValue({
      id: "org-1",
      planCode: "pro",
      subscriptionStatus: "canceled",
      stripeCustomerId: "cus_123",
      stripeSubscriptionId: "sub_old",
    });

    await expect(
      processStripeWebhookEvent(buildDb(), {
        id: "evt_subscription_rebind",
        type: "customer.subscription.created",
        data: {
          object: {
            id: "sub_new",
            customer: "cus_123",
            metadata: { organizationId: "org-1" },
            status: "active",
            trial_end: null,
            items: {
              data: [
                {
                  price: { id: "price_pro_monthly" },
                  current_period_start: 1_700_000_000,
                  current_period_end: 1_700_086_400,
                },
              ],
            },
          },
        },
      } as never),
    ).resolves.toBe("processed");

    expect(mockUpdateOrganizationBillingState).toHaveBeenCalledWith(
      expect.anything(),
      "org-1",
      expect.objectContaining({
        stripeSubscriptionId: "sub_new",
        subscriptionStatus: "active",
      }),
    );
  });

  it("maps paused Stripe subscriptions without collapsing them to free", async () => {
    mockFindOrganizationByStripeSubscriptionId.mockResolvedValue({
      id: "org-1",
      planCode: "pro",
      subscriptionStatus: "active",
      stripeCustomerId: "cus_123",
      stripeSubscriptionId: "sub_123",
    });

    await expect(
      processStripeWebhookEvent(buildDb(), {
        id: "evt_paused_subscription",
        type: "customer.subscription.updated",
        data: {
          object: {
            id: "sub_123",
            customer: "cus_123",
            metadata: { organizationId: "org-1" },
            status: "paused",
            trial_end: null,
            items: {
              data: [
                {
                  price: { id: "price_pro_monthly" },
                  current_period_start: 1_700_000_000,
                  current_period_end: 1_700_086_400,
                },
              ],
            },
          },
        },
      } as never),
    ).resolves.toBe("processed");

    expect(mockUpdateOrganizationBillingState).toHaveBeenCalledWith(
      expect.anything(),
      "org-1",
      expect.objectContaining({
        subscriptionStatus: "paused",
      }),
    );
  });

  it("ignores invoice payment events when they refer to a different subscription", async () => {
    mockFindOrganizationByStripeSubscriptionId.mockResolvedValue(null);
    mockFindOrganizationByStripeCustomerId.mockResolvedValue({
      id: "org-1",
      planCode: "pro",
      stripeCustomerId: "cus_123",
      stripeSubscriptionId: "sub_current",
    });

    await expect(
      processStripeWebhookEvent(buildDb(), {
        id: "evt_invoice_mismatch",
        type: "invoice.payment_failed",
        data: {
          object: {
            customer: "cus_123",
            parent: {
              subscription_details: {
                metadata: { organizationId: "org-1" },
                subscription: { id: "sub_other" },
              },
            },
          },
        },
      } as never),
    ).resolves.toBe("ignored");

    expect(mockUpdateOrganizationBillingState).not.toHaveBeenCalled();
  });

  it("ignores unsupported webhook event types", async () => {
    await expect(
      processStripeWebhookEvent(buildDb(), {
        id: "evt_unknown",
        type: "customer.created",
        data: { object: {} },
      } as never),
    ).resolves.toBe("ignored");
  });
});
