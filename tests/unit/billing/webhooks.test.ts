import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRecordBillingWebhookEvent = vi.fn();
vi.mock("../../../src/db/repos/billingWebhookEvents.js", () => ({
  recordBillingWebhookEvent: (...args: unknown[]): unknown =>
    mockRecordBillingWebhookEvent(...args),
}));

const mockFindUserById = vi.fn();
const mockFindUserByIdForUpdate = vi.fn();
const mockFindUserByStripeCustomerId = vi.fn();
const mockFindUserByStripeSubscriptionId = vi.fn();
const mockUpdateUserBillingState = vi.fn();
const mockUpdateUserPaidThroughAtIfLater = vi.fn();
vi.mock("../../../src/db/repos/users.js", () => ({
  findUserById: (...args: unknown[]): unknown => mockFindUserById(...args),
  findUserByIdForUpdate: (...args: unknown[]): unknown => mockFindUserByIdForUpdate(...args),
  findUserByStripeCustomerId: (...args: unknown[]): unknown =>
    mockFindUserByStripeCustomerId(...args),
  findUserByStripeSubscriptionId: (...args: unknown[]): unknown =>
    mockFindUserByStripeSubscriptionId(...args),
  updateUserBillingState: (...args: unknown[]): unknown => mockUpdateUserBillingState(...args),
  updateUserPaidThroughAtIfLater: (...args: unknown[]): unknown =>
    mockUpdateUserPaidThroughAtIfLater(...args),
}));

const mockFindLatestManualBillingEventForUser = vi.fn();
vi.mock("../../../src/db/repos/manualBillingEvents.js", () => ({
  findLatestManualBillingEventForUser: (...args: unknown[]): unknown =>
    mockFindLatestManualBillingEventForUser(...args),
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
    mockFindUserByIdForUpdate.mockResolvedValue(null);
    mockFindLatestManualBillingEventForUser.mockResolvedValue(null);
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

  it("updates user billing state from a mapped subscription price", async () => {
    const org = {
      id: 1n,
      planCode: "free",
      stripeCustomerId: null,
      stripeSubscriptionId: null,
    };
    mockFindUserByStripeSubscriptionId.mockResolvedValue(org);
    mockFindUserByIdForUpdate.mockResolvedValue(org);

    await expect(
      processStripeWebhookEvent(buildDb(), {
        id: "evt_sub",
        type: "customer.subscription.updated",
        data: {
          object: {
            id: "sub_123",
            customer: "cus_123",
            metadata: { telegramUserId: "1" },
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

    expect(mockUpdateUserBillingState).toHaveBeenCalledWith(
      expect.anything(),
      1n,
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
      id: 1n,
      planCode: "free",
      stripeCustomerId: null,
      stripeSubscriptionId: null,
    };
    mockFindUserByStripeSubscriptionId.mockResolvedValue(org);
    mockFindUserByIdForUpdate.mockResolvedValue(org);

    await expect(
      processStripeWebhookEvent(buildDb(), {
        id: "evt_unknown_price",
        type: "customer.subscription.updated",
        data: {
          object: {
            id: "sub_123",
            customer: "cus_123",
            metadata: { telegramUserId: "1" },
            status: "active",
            trial_end: null,
            items: { data: [{ price: { id: "price_unknown" } }] },
          },
        },
      } as never),
    ).resolves.toBe("ignored");

    expect(mockUpdateUserBillingState).not.toHaveBeenCalled();
  });

  it("does not overwrite unrelated manual business users", async () => {
    const org = {
      id: 2n,
      planCode: "business",
      stripeCustomerId: null,
      stripeSubscriptionId: null,
    };
    mockFindUserById.mockResolvedValue(org);
    mockFindUserByIdForUpdate.mockResolvedValue(org);

    await expect(
      processStripeWebhookEvent(buildDb(), {
        id: "evt_checkout",
        type: "checkout.session.completed",
        data: {
          object: {
            customer: "cus_accidental",
            metadata: { telegramUserId: "2" },
            client_reference_id: "2",
          },
        },
      } as never),
    ).resolves.toBe("ignored");

    expect(mockUpdateUserBillingState).not.toHaveBeenCalled();
  });

  it("does not overwrite business user with keptStripeLink=true even when Stripe IDs match", async () => {
    const org = {
      id: 3n,
      planCode: "business",
      stripeCustomerId: "cus_linked",
      stripeSubscriptionId: "sub_linked",
    };
    mockFindUserByStripeSubscriptionId.mockResolvedValue(org);
    mockFindUserByIdForUpdate.mockResolvedValue(org);
    // Latest manual event recorded keptStripeLink=true — operator wants business
    // entitlements even though the Stripe subscription is still active.
    mockFindLatestManualBillingEventForUser.mockResolvedValue({
      id: "evt-manual",
      telegramUserId: 3n,
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

    expect(mockUpdateUserBillingState).not.toHaveBeenCalled();
  });

  it("does not overwrite unlinked manual paid users resolved by metadata", async () => {
    const org = {
      id: 4n,
      planCode: "pro",
      subscriptionStatus: "active",
      stripeCustomerId: null,
      stripeSubscriptionId: null,
    };
    mockFindUserByStripeSubscriptionId.mockResolvedValue(null);
    mockFindUserByStripeCustomerId.mockResolvedValue(null);
    mockFindUserById.mockResolvedValue(org);
    mockFindUserByIdForUpdate.mockResolvedValue(org);

    await expect(
      processStripeWebhookEvent(buildDb(), {
        id: "evt_stale_manual_subscription",
        type: "customer.subscription.deleted",
        data: {
          object: {
            id: "sub_old",
            customer: "cus_old",
            metadata: { telegramUserId: "4" },
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

    expect(mockUpdateUserBillingState).not.toHaveBeenCalled();
  });

  it("processes checkout completion by linking the Stripe customer", async () => {
    const user = {
      id: 1n,
      planCode: "free",
      stripeCustomerId: null,
      stripeSubscriptionId: null,
    };
    mockFindUserById.mockResolvedValue(user);
    mockFindUserByIdForUpdate.mockResolvedValue(user);

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

    expect(mockUpdateUserBillingState).toHaveBeenCalledWith(expect.anything(), 1n, {
      stripeCustomerId: "cus_123",
    });
  });

  it("does not relink a manually downgraded free user from delayed checkout metadata", async () => {
    const org = {
      id: 1n,
      planCode: "free",
      subscriptionStatus: "free",
      stripeCustomerId: null,
      stripeSubscriptionId: null,
    };
    mockFindUserById.mockResolvedValue(org);
    mockFindUserByIdForUpdate.mockResolvedValue(org);
    mockFindLatestManualBillingEventForUser.mockResolvedValue({
      id: "event-free",
      telegramUserId: 1n,
      planCode: "free",
    });

    await expect(
      processStripeWebhookEvent(buildDb(), {
        id: "evt_checkout_after_manual_free",
        type: "checkout.session.completed",
        data: {
          object: {
            customer: "cus_old",
            metadata: { telegramUserId: "1" },
            client_reference_id: "1",
          },
        },
      } as never),
    ).resolves.toBe("ignored");

    expect(mockUpdateUserBillingState).not.toHaveBeenCalled();
  });

  it("does not overwrite a manually downgraded free user from delayed subscription metadata", async () => {
    const org = {
      id: 1n,
      planCode: "free",
      subscriptionStatus: "free",
      stripeCustomerId: null,
      stripeSubscriptionId: null,
    };
    mockFindUserByStripeSubscriptionId.mockResolvedValue(null);
    mockFindUserByStripeCustomerId.mockResolvedValue(null);
    mockFindUserById.mockResolvedValue(org);
    mockFindUserByIdForUpdate.mockResolvedValue(org);
    mockFindLatestManualBillingEventForUser.mockResolvedValue({
      id: "event-free",
      telegramUserId: 1n,
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
            metadata: { telegramUserId: "1" },
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

    expect(mockUpdateUserBillingState).not.toHaveBeenCalled();
  });

  it("ignores checkout completion when the user cannot be resolved", async () => {
    mockFindUserById.mockResolvedValue(null);

    await expect(
      processStripeWebhookEvent(buildDb(), {
        id: "evt_checkout_missing_user",
        type: "checkout.session.completed",
        data: {
          object: {
            customer: "cus_123",
            metadata: { telegramUserId: "999" },
            client_reference_id: "999",
          },
        },
      } as never),
    ).resolves.toBe("ignored");

    expect(mockUpdateUserBillingState).not.toHaveBeenCalled();
  });

  it("allows retry after a failed state update instead of treating the event as durable", async () => {
    const org = {
      id: 1n,
      planCode: "free",
      stripeCustomerId: null,
      stripeSubscriptionId: null,
    };
    mockFindUserByStripeSubscriptionId.mockResolvedValue(org);
    mockFindUserByIdForUpdate.mockResolvedValue(org);
    mockRecordBillingWebhookEvent.mockResolvedValue(true);
    mockUpdateUserBillingState
      .mockRejectedValueOnce(new Error("write failed"))
      .mockResolvedValueOnce({});

    const event = {
      id: "evt_retryable",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_123",
          customer: "cus_123",
          metadata: { telegramUserId: "1" },
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
      id: 1n,
      planCode: "pro",
      stripeCustomerId: "cus_123",
      stripeSubscriptionId: "sub_123",
      paidThroughAt: null,
    };
    mockFindUserByStripeSubscriptionId.mockResolvedValue(org);
    mockFindUserByIdForUpdate.mockResolvedValue(org);

    await expect(
      processStripeWebhookEvent(buildDb(), {
        id: "evt_invoice_paid",
        type: "invoice.payment_succeeded",
        data: {
          object: {
            customer: "cus_123",
            parent: {
              subscription_details: {
                metadata: { telegramUserId: "1" },
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

    expect(mockUpdateUserPaidThroughAtIfLater).toHaveBeenCalledWith(
      expect.anything(),
      1n,
      new Date(1_700_086_400 * 1000),
    );
  });

  it("uses the latest subscription service-period line for paid-through time", async () => {
    const org = {
      id: 1n,
      planCode: "pro",
      stripeCustomerId: "cus_123",
      stripeSubscriptionId: "sub_123",
      paidThroughAt: null,
    };
    mockFindUserByStripeSubscriptionId.mockResolvedValue(org);
    mockFindUserByIdForUpdate.mockResolvedValue(org);

    await expect(
      processStripeWebhookEvent(buildDb(), {
        id: "evt_invoice_paid_lines",
        type: "invoice.payment_succeeded",
        data: {
          object: {
            customer: "cus_123",
            parent: {
              subscription_details: {
                metadata: { telegramUserId: "1" },
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

    expect(mockUpdateUserPaidThroughAtIfLater).toHaveBeenCalledWith(
      expect.anything(),
      1n,
      new Date(1_700_172_800 * 1000),
    );
  });

  it("delegates paid-through monotonicity to the user repo", async () => {
    const org = {
      id: 1n,
      planCode: "pro",
      stripeCustomerId: "cus_123",
      stripeSubscriptionId: "sub_123",
      paidThroughAt: new Date(1_700_172_800 * 1000),
    };
    mockFindUserByStripeSubscriptionId.mockResolvedValue(org);
    mockFindUserByIdForUpdate.mockResolvedValue(org);

    await expect(
      processStripeWebhookEvent(buildDb(), {
        id: "evt_invoice_paid_monotonic",
        type: "invoice.payment_succeeded",
        data: {
          object: {
            customer: "cus_123",
            parent: {
              subscription_details: {
                metadata: { telegramUserId: "1" },
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

    expect(mockUpdateUserPaidThroughAtIfLater).toHaveBeenCalledWith(
      expect.anything(),
      1n,
      new Date(1_700_086_400 * 1000),
    );
  });

  it("ignores failed invoice payments so they cannot clobber subscription state", async () => {
    mockFindUserByStripeSubscriptionId.mockResolvedValue({
      id: 1n,
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
                metadata: { telegramUserId: "1" },
                subscription: "sub_123",
              },
            },
          },
        },
      } as never),
    ).resolves.toBe("ignored");

    expect(mockUpdateUserBillingState).not.toHaveBeenCalled();
  });

  it("ignores stale subscription updates for a different subscription on the same customer", async () => {
    const org = {
      id: 1n,
      planCode: "pro",
      subscriptionStatus: "active",
      stripeCustomerId: "cus_123",
      stripeSubscriptionId: "sub_current",
    };
    mockFindUserByStripeSubscriptionId.mockResolvedValue(null);
    mockFindUserByStripeCustomerId.mockResolvedValue(org);
    mockFindUserByIdForUpdate.mockResolvedValue(org);

    await expect(
      processStripeWebhookEvent(buildDb(), {
        id: "evt_stale_subscription",
        type: "customer.subscription.deleted",
        data: {
          object: {
            id: "sub_old",
            customer: "cus_123",
            metadata: { telegramUserId: "1" },
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

    expect(mockUpdateUserBillingState).not.toHaveBeenCalled();
  });

  it("allows a new subscription.created event to replace a terminal prior subscription", async () => {
    const org = {
      id: 1n,
      planCode: "pro",
      subscriptionStatus: "canceled",
      stripeCustomerId: "cus_123",
      stripeSubscriptionId: "sub_old",
    };
    mockFindUserByStripeSubscriptionId.mockResolvedValue(null);
    mockFindUserByStripeCustomerId.mockResolvedValue(org);
    mockFindUserByIdForUpdate.mockResolvedValue(org);

    await expect(
      processStripeWebhookEvent(buildDb(), {
        id: "evt_subscription_rebind",
        type: "customer.subscription.created",
        data: {
          object: {
            id: "sub_new",
            customer: "cus_123",
            metadata: { telegramUserId: "1" },
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

    expect(mockUpdateUserBillingState).toHaveBeenCalledWith(
      expect.anything(),
      1n,
      expect.objectContaining({
        stripeSubscriptionId: "sub_new",
        subscriptionStatus: "active",
      }),
    );
  });

  it("maps paused Stripe subscriptions without collapsing them to free", async () => {
    const org = {
      id: 1n,
      planCode: "pro",
      subscriptionStatus: "active",
      stripeCustomerId: "cus_123",
      stripeSubscriptionId: "sub_123",
    };
    mockFindUserByStripeSubscriptionId.mockResolvedValue(org);
    mockFindUserByIdForUpdate.mockResolvedValue(org);

    await expect(
      processStripeWebhookEvent(buildDb(), {
        id: "evt_paused_subscription",
        type: "customer.subscription.updated",
        data: {
          object: {
            id: "sub_123",
            customer: "cus_123",
            metadata: { telegramUserId: "1" },
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

    expect(mockUpdateUserBillingState).toHaveBeenCalledWith(
      expect.anything(),
      1n,
      expect.objectContaining({
        subscriptionStatus: "paused",
      }),
    );
  });

  it("ignores invoice payment events when they refer to a different subscription", async () => {
    mockFindUserByStripeSubscriptionId.mockResolvedValue(null);
    mockFindUserByStripeCustomerId.mockResolvedValue({
      id: 1n,
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
                metadata: { telegramUserId: "1" },
                subscription: { id: "sub_other" },
              },
            },
          },
        },
      } as never),
    ).resolves.toBe("ignored");

    expect(mockUpdateUserBillingState).not.toHaveBeenCalled();
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

  it("ignores a stale checkout event with a mismatched Stripe customer for a non-business user", async () => {
    // User was re-linked to cus_new after a fresh checkout. A delayed
    // checkout.session.completed for the old customer arrives via metadata.
    const org = {
      id: 1n,
      planCode: "pro",
      subscriptionStatus: "active",
      stripeCustomerId: "cus_new",
      stripeSubscriptionId: "sub_new",
    };
    mockFindUserByStripeCustomerId.mockResolvedValue(null);
    mockFindUserById.mockResolvedValue(org);
    mockFindUserByIdForUpdate.mockResolvedValue(org);

    await expect(
      processStripeWebhookEvent(buildDb(), {
        id: "evt_stale_checkout_mismatch",
        type: "checkout.session.completed",
        data: {
          object: {
            customer: "cus_old",
            metadata: { telegramUserId: "1" },
            client_reference_id: "1",
          },
        },
      } as never),
    ).resolves.toBe("ignored");

    expect(mockUpdateUserBillingState).not.toHaveBeenCalled();
  });

  it("ignores a stale subscription event with mismatched Stripe IDs for a non-business user routed by telegramUserId metadata", async () => {
    // User is now linked to cus_new/sub_new. A delayed subscription event for
    // sub_old/cus_old arrives and is routed only via userId metadata.
    const org = {
      id: 1n,
      planCode: "pro",
      subscriptionStatus: "active",
      stripeCustomerId: "cus_new",
      stripeSubscriptionId: "sub_new",
    };
    mockFindUserByStripeSubscriptionId.mockResolvedValue(null);
    mockFindUserByStripeCustomerId.mockResolvedValue(null);
    mockFindUserById.mockResolvedValue(org);
    mockFindUserByIdForUpdate.mockResolvedValue(org);

    await expect(
      processStripeWebhookEvent(buildDb(), {
        id: "evt_stale_sub_mismatch",
        type: "customer.subscription.updated",
        data: {
          object: {
            id: "sub_old",
            customer: "cus_old",
            metadata: { telegramUserId: "1" },
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

    expect(mockUpdateUserBillingState).not.toHaveBeenCalled();
  });
});
