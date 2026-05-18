import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRecordBillingWebhookEvent = vi.fn();
vi.mock("../../../src/db/repos/billingWebhookEvents.js", () => ({
  recordBillingWebhookEvent: (...args: unknown[]): unknown =>
    mockRecordBillingWebhookEvent(...args),
}));

const mockFindOrganizationById = vi.fn();
const mockFindOrganizationByIdForUpdate = vi.fn();
const mockFindOrganizationByStripeCustomerId = vi.fn();
const mockFindOrganizationByStripeSubscriptionId = vi.fn();
const mockUpdateOrganizationBillingState = vi.fn();
const mockUpdateOrganizationPaidThroughAtIfLater = vi.fn();
vi.mock("../../../src/db/repos/users.js", () => ({
  findUserById: (...args: unknown[]): unknown => mockFindOrganizationById(...args),
  findUserByIdForUpdate: (...args: unknown[]): unknown =>
    mockFindOrganizationByIdForUpdate(...args),
  findUserByStripeCustomerId: (...args: unknown[]): unknown =>
    mockFindOrganizationByStripeCustomerId(...args),
  findUserByStripeSubscriptionId: (...args: unknown[]): unknown =>
    mockFindOrganizationByStripeSubscriptionId(...args),
  updateUserBillingState: (...args: unknown[]): unknown =>
    mockUpdateOrganizationBillingState(...args),
  updateUserPaidThroughAtIfLater: (...args: unknown[]): unknown =>
    mockUpdateOrganizationPaidThroughAtIfLater(...args),
}));

const mockFindLatestManualBillingEventForOrganization = vi.fn();
vi.mock("../../../src/db/repos/manualBillingEvents.js", () => ({
  findLatestManualBillingEventForUser: (...args: unknown[]): unknown =>
    mockFindLatestManualBillingEventForOrganization(...args),
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
    mockFindOrganizationByIdForUpdate.mockResolvedValue(null);
    mockFindLatestManualBillingEventForOrganization.mockResolvedValue(null);
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
    const org = {
      id: "org-1",
      planCode: "free",
      stripeCustomerId: null,
      stripeSubscriptionId: null,
    };
    mockFindOrganizationByStripeSubscriptionId.mockResolvedValue(org);
    mockFindOrganizationByIdForUpdate.mockResolvedValue(org);

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
    const org = {
      id: "org-1",
      planCode: "free",
      stripeCustomerId: null,
      stripeSubscriptionId: null,
    };
    mockFindOrganizationByStripeSubscriptionId.mockResolvedValue(org);
    mockFindOrganizationByIdForUpdate.mockResolvedValue(org);

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
    const org = {
      id: "org-business",
      planCode: "business",
      stripeCustomerId: null,
      stripeSubscriptionId: null,
    };
    mockFindOrganizationById.mockResolvedValue(org);
    mockFindOrganizationByIdForUpdate.mockResolvedValue(org);

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

  it("does not overwrite business org with keptStripeLink=true even when Stripe IDs match", async () => {
    const org = {
      id: "org-linked-business",
      planCode: "business",
      stripeCustomerId: "cus_linked",
      stripeSubscriptionId: "sub_linked",
    };
    mockFindOrganizationByStripeSubscriptionId.mockResolvedValue(org);
    mockFindOrganizationByIdForUpdate.mockResolvedValue(org);
    // Latest manual event recorded keptStripeLink=true — operator wants business
    // entitlements even though the Stripe subscription is still active.
    mockFindLatestManualBillingEventForOrganization.mockResolvedValue({
      id: "evt-manual",
      organizationId: "org-linked-business",
      planCode: "business",
      subscriptionStatus: "active",
      keptStripeLink: true,
    });

    await expect(
      processStripeWebhookEvent(buildDb(), {
        id: "evt_sub_updated",
        type: "customer.subscription.updated",
        data: {
          object: {
            id: "sub_linked",
            customer: "cus_linked",
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
    ).resolves.toBe("ignored");

    expect(mockUpdateOrganizationBillingState).not.toHaveBeenCalled();
  });

  it("does not overwrite unlinked manual paid organizations resolved by metadata", async () => {
    const org = {
      id: "org-manual",
      planCode: "pro",
      subscriptionStatus: "active",
      stripeCustomerId: null,
      stripeSubscriptionId: null,
    };
    mockFindOrganizationByStripeSubscriptionId.mockResolvedValue(null);
    mockFindOrganizationByStripeCustomerId.mockResolvedValue(null);
    mockFindOrganizationById.mockResolvedValue(org);
    mockFindOrganizationByIdForUpdate.mockResolvedValue(org);

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
    const user = {
      id: 1n,
      planCode: "free",
      stripeCustomerId: null,
      stripeSubscriptionId: null,
    };
    mockFindOrganizationById.mockResolvedValue(user);
    mockFindOrganizationByIdForUpdate.mockResolvedValue(user);

    await expect(
      processStripeWebhookEvent(buildDb(), {
        id: "evt_checkout_success",
        type: "checkout.session.completed",
        data: {
          object: {
            customer: "cus_123",
            metadata: { telegramUserId: "1" },
            client_reference_id: "1",
          },
        },
      } as never),
    ).resolves.toBe("processed");

    expect(mockUpdateOrganizationBillingState).toHaveBeenCalledWith(expect.anything(), 1n, {
      stripeCustomerId: "cus_123",
    });
  });

  it("does not relink a manually downgraded free organization from delayed checkout metadata", async () => {
    const org = {
      id: "org-1",
      planCode: "free",
      subscriptionStatus: "free",
      stripeCustomerId: null,
      stripeSubscriptionId: null,
    };
    mockFindOrganizationById.mockResolvedValue(org);
    mockFindOrganizationByIdForUpdate.mockResolvedValue(org);
    mockFindLatestManualBillingEventForOrganization.mockResolvedValue({
      id: "event-free",
      organizationId: "org-1",
      planCode: "free",
    });

    await expect(
      processStripeWebhookEvent(buildDb(), {
        id: "evt_checkout_after_manual_free",
        type: "checkout.session.completed",
        data: {
          object: {
            customer: "cus_old",
            metadata: { organizationId: "org-1" },
            client_reference_id: "org-1",
          },
        },
      } as never),
    ).resolves.toBe("ignored");

    expect(mockUpdateOrganizationBillingState).not.toHaveBeenCalled();
  });

  it("does not overwrite a manually downgraded free organization from delayed subscription metadata", async () => {
    const org = {
      id: "org-1",
      planCode: "free",
      subscriptionStatus: "free",
      stripeCustomerId: null,
      stripeSubscriptionId: null,
    };
    mockFindOrganizationByStripeSubscriptionId.mockResolvedValue(null);
    mockFindOrganizationByStripeCustomerId.mockResolvedValue(null);
    mockFindOrganizationById.mockResolvedValue(org);
    mockFindOrganizationByIdForUpdate.mockResolvedValue(org);
    mockFindLatestManualBillingEventForOrganization.mockResolvedValue({
      id: "event-free",
      organizationId: "org-1",
      planCode: "free",
    });

    await expect(
      processStripeWebhookEvent(buildDb(), {
        id: "evt_subscription_after_manual_free",
        type: "customer.subscription.updated",
        data: {
          object: {
            id: "sub_old",
            customer: "cus_old",
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
    ).resolves.toBe("ignored");

    expect(mockUpdateOrganizationBillingState).not.toHaveBeenCalled();
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
    const org = {
      id: "org-1",
      planCode: "free",
      stripeCustomerId: null,
      stripeSubscriptionId: null,
    };
    mockFindOrganizationByStripeSubscriptionId.mockResolvedValue(org);
    mockFindOrganizationByIdForUpdate.mockResolvedValue(org);
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
    const org = {
      id: "org-1",
      planCode: "pro",
      stripeCustomerId: "cus_123",
      stripeSubscriptionId: "sub_123",
      paidThroughAt: null,
    };
    mockFindOrganizationByStripeSubscriptionId.mockResolvedValue(org);
    mockFindOrganizationByIdForUpdate.mockResolvedValue(org);

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
    const org = {
      id: "org-1",
      planCode: "pro",
      stripeCustomerId: "cus_123",
      stripeSubscriptionId: "sub_123",
      paidThroughAt: null,
    };
    mockFindOrganizationByStripeSubscriptionId.mockResolvedValue(org);
    mockFindOrganizationByIdForUpdate.mockResolvedValue(org);

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
    const org = {
      id: "org-1",
      planCode: "pro",
      stripeCustomerId: "cus_123",
      stripeSubscriptionId: "sub_123",
      paidThroughAt: new Date(1_700_172_800 * 1000),
    };
    mockFindOrganizationByStripeSubscriptionId.mockResolvedValue(org);
    mockFindOrganizationByIdForUpdate.mockResolvedValue(org);

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
    const org = {
      id: "org-1",
      planCode: "pro",
      subscriptionStatus: "active",
      stripeCustomerId: "cus_123",
      stripeSubscriptionId: "sub_current",
    };
    mockFindOrganizationByStripeSubscriptionId.mockResolvedValue(null);
    mockFindOrganizationByStripeCustomerId.mockResolvedValue(org);
    mockFindOrganizationByIdForUpdate.mockResolvedValue(org);

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
    const org = {
      id: "org-1",
      planCode: "pro",
      subscriptionStatus: "canceled",
      stripeCustomerId: "cus_123",
      stripeSubscriptionId: "sub_old",
    };
    mockFindOrganizationByStripeSubscriptionId.mockResolvedValue(null);
    mockFindOrganizationByStripeCustomerId.mockResolvedValue(org);
    mockFindOrganizationByIdForUpdate.mockResolvedValue(org);

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
    const org = {
      id: "org-1",
      planCode: "pro",
      subscriptionStatus: "active",
      stripeCustomerId: "cus_123",
      stripeSubscriptionId: "sub_123",
    };
    mockFindOrganizationByStripeSubscriptionId.mockResolvedValue(org);
    mockFindOrganizationByIdForUpdate.mockResolvedValue(org);

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

  it("ignores a stale checkout event with a mismatched Stripe customer for a non-business org", async () => {
    // Org was re-linked to cus_new after a fresh checkout. A delayed
    // checkout.session.completed for the old customer arrives via metadata.
    const org = {
      id: "org-1",
      planCode: "pro",
      subscriptionStatus: "active",
      stripeCustomerId: "cus_new",
      stripeSubscriptionId: "sub_new",
    };
    mockFindOrganizationByStripeCustomerId.mockResolvedValue(null);
    mockFindOrganizationById.mockResolvedValue(org);
    mockFindOrganizationByIdForUpdate.mockResolvedValue(org);

    await expect(
      processStripeWebhookEvent(buildDb(), {
        id: "evt_stale_checkout_mismatch",
        type: "checkout.session.completed",
        data: {
          object: {
            customer: "cus_old",
            metadata: { organizationId: "org-1" },
            client_reference_id: "org-1",
          },
        },
      } as never),
    ).resolves.toBe("ignored");

    expect(mockUpdateOrganizationBillingState).not.toHaveBeenCalled();
  });

  it("ignores a stale subscription event with mismatched Stripe IDs for a non-business org routed by metadata", async () => {
    // Org is now linked to cus_new/sub_new. A delayed subscription event for
    // sub_old/cus_old arrives and is routed only via organizationId metadata.
    const org = {
      id: "org-1",
      planCode: "pro",
      subscriptionStatus: "active",
      stripeCustomerId: "cus_new",
      stripeSubscriptionId: "sub_new",
    };
    mockFindOrganizationByStripeSubscriptionId.mockResolvedValue(null);
    mockFindOrganizationByStripeCustomerId.mockResolvedValue(null);
    mockFindOrganizationById.mockResolvedValue(org);
    mockFindOrganizationByIdForUpdate.mockResolvedValue(org);

    await expect(
      processStripeWebhookEvent(buildDb(), {
        id: "evt_stale_sub_mismatch",
        type: "customer.subscription.updated",
        data: {
          object: {
            id: "sub_old",
            customer: "cus_old",
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
    ).resolves.toBe("ignored");

    expect(mockUpdateOrganizationBillingState).not.toHaveBeenCalled();
  });
});
