import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFindOrganizationById = vi.fn();
const mockFindOrganizationByIdForUpdate = vi.fn();
const mockUpdateOrganizationBillingState = vi.fn();
const mockCreateOrganization = vi.fn();
const mockFindOrCreateUserById = vi.fn();
const mockListOrganizationMembershipsForUser = vi.fn();
const mockUserHasOrganizationRole = vi.fn();
const mockAddOrganizationMember = vi.fn();
const mockCreateManualBillingEvent = vi.fn();
const mockFindAnyManualBillingEventByPaymentReference = vi.fn();
const mockFindManualBillingEventByPaymentReference = vi.fn();
const mockFindManualBillingEventByUserAndPaymentReference = vi.fn();
const mockFindOrCreateManualBillingEvent = vi.fn();

vi.mock("../../../src/db/repos/organizations.js", () => ({
  findOrganizationById: (...args: unknown[]): unknown => mockFindOrganizationById(...args),
  findOrganizationByIdForUpdate: (...args: unknown[]): unknown =>
    mockFindOrganizationByIdForUpdate(...args),
  updateOrganizationBillingState: (...args: unknown[]): unknown =>
    mockUpdateOrganizationBillingState(...args),
  createOrganization: (...args: unknown[]): unknown => mockCreateOrganization(...args),
}));

vi.mock("../../../src/db/repos/users.js", () => ({
  findOrCreateUserById: (...args: unknown[]): unknown => mockFindOrCreateUserById(...args),
}));

vi.mock("../../../src/db/repos/organizationMembers.js", () => ({
  listOrganizationMembershipsForUser: (...args: unknown[]): unknown =>
    mockListOrganizationMembershipsForUser(...args),
  userHasOrganizationRole: (...args: unknown[]): unknown => mockUserHasOrganizationRole(...args),
  addOrganizationMember: (...args: unknown[]): unknown => mockAddOrganizationMember(...args),
}));

vi.mock("../../../src/db/repos/manualBillingEvents.js", () => ({
  createManualBillingEvent: (...args: unknown[]): unknown => mockCreateManualBillingEvent(...args),
  findAnyManualBillingEventByPaymentReference: (...args: unknown[]): unknown =>
    mockFindAnyManualBillingEventByPaymentReference(...args),
  findManualBillingEventByPaymentReference: (...args: unknown[]): unknown =>
    mockFindManualBillingEventByPaymentReference(...args),
  findManualBillingEventByUserAndPaymentReference: (...args: unknown[]): unknown =>
    mockFindManualBillingEventByUserAndPaymentReference(...args),
  findOrCreateManualBillingEvent: (...args: unknown[]): unknown =>
    mockFindOrCreateManualBillingEvent(...args),
}));

const fakeTx = { execute: vi.fn().mockResolvedValue(undefined) };
const fakeDb = {
  transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work(fakeTx)),
  execute: vi.fn().mockResolvedValue(null), // used in OrgCreationRaceSignal recovery path
} as unknown as Parameters<
  typeof import("../../../src/billing/manual.js").grantManualOrganizationPlan
>[0];

const { grantManualOrganizationPlan, grantManualUserPlan, addManualOrganizationMember } =
  await import("../../../src/billing/manual.js");

const PAID_THROUGH = new Date("2026-05-30T00:00:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  const defaultOrg = {
    id: "org-1",
    name: "Org 1",
    planCode: "free",
    subscriptionStatus: "free",
    stripeCustomerId: "cus_existing",
    stripeSubscriptionId: "sub_existing",
    paidThroughAt: null,
    trialEndsAt: null,
    currentPeriodStart: null,
    currentPeriodEnd: null,
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
  mockFindOrganizationById.mockResolvedValue(defaultOrg);
  mockFindOrganizationByIdForUpdate.mockResolvedValue(defaultOrg);
  mockFindAnyManualBillingEventByPaymentReference.mockResolvedValue(null);
  mockFindManualBillingEventByPaymentReference.mockResolvedValue(null);
  mockFindManualBillingEventByUserAndPaymentReference.mockResolvedValue(null);
  mockUpdateOrganizationBillingState.mockResolvedValue({
    id: "org-1",
    planCode: "pro",
    subscriptionStatus: "active",
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    paidThroughAt: PAID_THROUGH,
  });
  mockCreateOrganization.mockResolvedValue({ id: "org-new", name: "Telegram 12345" });
  mockFindOrCreateUserById.mockResolvedValue({ id: 12345n, username: null, isAllowed: false });
  mockListOrganizationMembershipsForUser.mockResolvedValue([]);
  mockUserHasOrganizationRole.mockResolvedValue(true);
  mockAddOrganizationMember.mockResolvedValue({
    organizationId: "org-1",
    userId: 12345n,
    role: "owner",
  });
  mockCreateManualBillingEvent.mockImplementation((_tx: unknown, data: Record<string, unknown>) =>
    Promise.resolve({
      id: "event-1",
      ...data,
      createdAt: new Date(),
    }),
  );
  mockFindOrCreateManualBillingEvent.mockImplementation(
    (_tx: unknown, data: Record<string, unknown>) =>
      Promise.resolve({
        event: { id: "event-1", ...data, createdAt: new Date() },
        created: true,
      }),
  );
});

describe("grantManualOrganizationPlan", () => {
  it("rejects when organization is not found", async () => {
    mockFindOrganizationByIdForUpdate.mockResolvedValueOnce(null);
    const result = await grantManualOrganizationPlan(fakeDb, {
      organizationId: "missing",
      planCode: "pro",
      subscriptionStatus: "active",
      paidThroughAt: PAID_THROUGH,
      paymentReference: "ref-notfound-001",
      note: null,
      keptStripeLink: false,
      operatorSource: "cli",
    });
    expect(result).toEqual({ ok: false, code: "organization_not_found" });
    expect(mockUpdateOrganizationBillingState).not.toHaveBeenCalled();
    expect(mockCreateManualBillingEvent).not.toHaveBeenCalled();
  });

  it("rejects when paymentReference is missing at service layer", async () => {
    const result = await grantManualOrganizationPlan(fakeDb, {
      organizationId: "org-1",
      planCode: "pro",
      subscriptionStatus: "active",
      paidThroughAt: PAID_THROUGH,
      paymentReference: "" as unknown as string,
      note: null,
      keptStripeLink: false,
      operatorSource: "cli",
    });
    expect(result).toEqual({ ok: false, code: "payment_reference_required" });
    expect(mockUpdateOrganizationBillingState).not.toHaveBeenCalled();
  });

  it("rejects keep_stripe_link for non-business plans", async () => {
    const result = await grantManualOrganizationPlan(fakeDb, {
      organizationId: "org-1",
      planCode: "pro",
      subscriptionStatus: "active",
      paidThroughAt: PAID_THROUGH,
      paymentReference: "" as unknown as string,
      note: null,
      keptStripeLink: true,
      operatorSource: "cli",
    });
    expect(result).toEqual({ ok: false, code: "keep_stripe_link_not_allowed" });
  });

  it("rejects keep_stripe_link for free plan", async () => {
    const result = await grantManualOrganizationPlan(fakeDb, {
      organizationId: "org-1",
      planCode: "free",
      subscriptionStatus: "free",
      paidThroughAt: null,
      paymentReference: "" as unknown as string,
      note: null,
      keptStripeLink: true,
      operatorSource: "cli",
    });
    expect(result).toEqual({ ok: false, code: "keep_stripe_link_not_allowed" });
  });

  it("rejects free plan with active status", async () => {
    const result = await grantManualOrganizationPlan(fakeDb, {
      organizationId: "org-1",
      planCode: "free",
      subscriptionStatus: "active",
      paidThroughAt: null,
      paymentReference: "" as unknown as string,
      note: null,
      keptStripeLink: false,
      operatorSource: "cli",
    });
    expect(result).toEqual({ ok: false, code: "free_status_required" });
  });

  it("requires paid_through for paid plans except business", async () => {
    const result = await grantManualOrganizationPlan(fakeDb, {
      organizationId: "org-1",
      planCode: "pro",
      subscriptionStatus: "active",
      paidThroughAt: null,
      paymentReference: "" as unknown as string,
      note: null,
      keptStripeLink: false,
      operatorSource: "cli",
    });
    expect(result).toEqual({ ok: false, code: "paid_through_required" });
  });

  it("allows business plan without paid_through", async () => {
    const result = await grantManualOrganizationPlan(fakeDb, {
      organizationId: "org-1",
      planCode: "business",
      subscriptionStatus: "active",
      paidThroughAt: null,
      paymentReference: "business-ref-001",
      note: null,
      keptStripeLink: false,
      operatorSource: "cli",
    });
    expect(result.ok).toBe(true);
    expect(mockUpdateOrganizationBillingState).toHaveBeenCalledWith(
      expect.anything(),
      "org-1",
      expect.objectContaining({
        planCode: "business",
        subscriptionStatus: "active",
        stripeCustomerId: null,
        stripeSubscriptionId: null,
      }),
    );
  });

  it("happy path: updates billing state, clears stripe ids, creates event", async () => {
    const result = await grantManualOrganizationPlan(fakeDb, {
      organizationId: "org-1",
      planCode: "pro",
      subscriptionStatus: "active",
      paidThroughAt: PAID_THROUGH,
      paymentReference: "wise-2026-04-001",
      note: "Manual Wise payment",
      keptStripeLink: false,
      operatorSource: "cli",
    });

    expect(result).toMatchObject({
      ok: true,
      idempotent: false,
      organizationId: "org-1",
      planCode: "pro",
      subscriptionStatus: "active",
      paidThroughAt: PAID_THROUGH.toISOString(),
      paymentReference: "wise-2026-04-001",
      keptStripeLink: false,
      manualBillingEventId: "event-1",
      operatorSource: "cli",
    });

    expect(mockUpdateOrganizationBillingState).toHaveBeenCalledWith(
      expect.anything(),
      "org-1",
      expect.objectContaining({
        planCode: "pro",
        subscriptionStatus: "active",
        paidThroughAt: PAID_THROUGH,
        stripeCustomerId: null,
        stripeSubscriptionId: null,
      }),
    );
    expect(mockFindOrCreateManualBillingEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        organizationId: "org-1",
        planCode: "pro",
        subscriptionStatus: "active",
        paymentReference: "wise-2026-04-001",
        note: "Manual Wise payment",
        keptStripeLink: false,
        operatorSource: "cli",
      }),
    );
  });

  it("rejects paid_through_not_allowed when canceled status has a paid-through date", async () => {
    const result = await grantManualOrganizationPlan(fakeDb, {
      organizationId: "org-1",
      planCode: "pro",
      subscriptionStatus: "canceled",
      paidThroughAt: new Date("2026-12-31T00:00:00.000Z"),
      paymentReference: "cancel-ref-001",
      note: null,
      keptStripeLink: false,
      operatorSource: "cli",
    });
    expect(result).toEqual({ ok: false, code: "paid_through_not_allowed" });
    expect(mockUpdateOrganizationBillingState).not.toHaveBeenCalled();
  });

  it("allows canceled status with null paid-through date", async () => {
    mockFindOrCreateManualBillingEvent.mockResolvedValueOnce({
      event: {
        id: "ev-1",
        organizationId: "org-1",
        planCode: "pro",
        subscriptionStatus: "canceled",
        paidThroughAt: null,
        paymentReference: "cancel-ref-002",
        note: null,
        keptStripeLink: false,
        operatorSource: "cli",
        telegramUserId: null,
      },
      created: true,
    });

    const result = await grantManualOrganizationPlan(fakeDb, {
      organizationId: "org-1",
      planCode: "pro",
      subscriptionStatus: "canceled",
      paidThroughAt: null,
      paymentReference: "cancel-ref-002",
      note: null,
      keptStripeLink: false,
      operatorSource: "cli",
    });
    expect(result).toMatchObject({ ok: true, subscriptionStatus: "canceled" });
    expect(mockUpdateOrganizationBillingState).toHaveBeenCalled();
  });

  it("rejects canceled_not_allowed_for_business when business plan is set to canceled", async () => {
    const result = await grantManualOrganizationPlan(fakeDb, {
      organizationId: "org-1",
      planCode: "business",
      subscriptionStatus: "canceled",
      paidThroughAt: null,
      paymentReference: "biz-cancel-ref-001",
      note: null,
      keptStripeLink: false,
      operatorSource: "cli",
    });
    expect(result).toEqual({ ok: false, code: "canceled_not_allowed_for_business" });
    expect(mockUpdateOrganizationBillingState).not.toHaveBeenCalled();
  });

  it("trims paymentReference and uses the normalized value as idempotency key", async () => {
    mockFindOrCreateManualBillingEvent.mockResolvedValueOnce({
      event: {
        id: "ev-trim",
        organizationId: "org-1",
        planCode: "pro",
        subscriptionStatus: "active",
        paidThroughAt: PAID_THROUGH,
        paymentReference: "trimmed-ref-001",
        note: null,
        keptStripeLink: false,
        operatorSource: "cli",
        telegramUserId: null,
      },
      created: true,
    });

    const result = await grantManualOrganizationPlan(fakeDb, {
      organizationId: "org-1",
      planCode: "pro",
      subscriptionStatus: "active",
      paidThroughAt: PAID_THROUGH,
      paymentReference: "  trimmed-ref-001  ", // leading/trailing whitespace
      note: "  some note  ",
      keptStripeLink: false,
      operatorSource: "cli",
    });

    expect(result).toMatchObject({ ok: true, paymentReference: "trimmed-ref-001" });
    // Event was stored with the trimmed reference
    expect(mockFindOrCreateManualBillingEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ paymentReference: "trimmed-ref-001" }),
    );
  });

  it("rejects blank paymentReference after trimming", async () => {
    const result = await grantManualOrganizationPlan(fakeDb, {
      organizationId: "org-1",
      planCode: "pro",
      subscriptionStatus: "active",
      paidThroughAt: PAID_THROUGH,
      paymentReference: "   ", // whitespace only
      note: null,
      keptStripeLink: false,
      operatorSource: "cli",
    });
    expect(result).toEqual({ ok: false, code: "payment_reference_required" });
  });

  it("rejects paid plan with free subscription status at service layer", async () => {
    const result = await grantManualOrganizationPlan(fakeDb, {
      organizationId: "org-1",
      planCode: "pro",
      subscriptionStatus: "free",
      paidThroughAt: null,
      paymentReference: "" as unknown as string,
      note: null,
      keptStripeLink: false,
      operatorSource: "cli",
    });
    expect(result).toEqual({ ok: false, code: "free_status_not_allowed_for_paid_plan" });
    expect(mockUpdateOrganizationBillingState).not.toHaveBeenCalled();
  });

  it("rejects with concurrent_update when expectedUpdatedAt does not match org.updatedAt", async () => {
    const orgUpdatedAt = new Date("2026-01-15T10:00:00.000Z");
    mockFindOrganizationByIdForUpdate.mockResolvedValue({
      id: "org-1",
      name: "Org 1",
      planCode: "free",
      subscriptionStatus: "free",
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      paidThroughAt: null,
      updatedAt: orgUpdatedAt,
    });
    // findOrCreateManualBillingEvent inserts a new event (created: true), then
    // version check fires and throws ConcurrentUpdateSignal to roll it back.
    mockFindOrCreateManualBillingEvent.mockResolvedValueOnce({
      event: { id: "event-new", organizationId: "org-1", planCode: "pro" },
      created: true,
    });

    const result = await grantManualOrganizationPlan(fakeDb, {
      organizationId: "org-1",
      planCode: "pro",
      subscriptionStatus: "active",
      paidThroughAt: new Date("2026-12-31"),
      paymentReference: "wise-test-001",
      note: null,
      keptStripeLink: false,
      operatorSource: "cli",
      expectedUpdatedAt: "2026-01-14T10:00:00.000Z", // stale — differs from org.updatedAt
    });

    expect(result).toEqual({ ok: false, code: "concurrent_update" });
    expect(mockUpdateOrganizationBillingState).not.toHaveBeenCalled();
  });

  it("proceeds normally when expectedUpdatedAt matches org.updatedAt", async () => {
    const orgUpdatedAt = new Date("2026-01-15T10:00:00.000Z");
    mockFindOrganizationByIdForUpdate.mockResolvedValue({
      id: "org-1",
      name: "Org 1",
      planCode: "free",
      subscriptionStatus: "free",
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      paidThroughAt: null,
      updatedAt: orgUpdatedAt,
    });
    // Default mockFindOrCreateManualBillingEvent returns { created: true }

    const result = await grantManualOrganizationPlan(fakeDb, {
      organizationId: "org-1",
      planCode: "pro",
      subscriptionStatus: "active",
      paidThroughAt: new Date("2026-12-31"),
      paymentReference: "version-match-ref-001",
      note: null,
      keptStripeLink: false,
      operatorSource: "cli",
      expectedUpdatedAt: "2026-01-15T10:00:00.000Z", // matches
    });

    expect(result).toMatchObject({ ok: true, planCode: "pro" });
    expect(mockUpdateOrganizationBillingState).toHaveBeenCalled();
  });

  it("clears stripe ids on free downgrade", async () => {
    await grantManualOrganizationPlan(fakeDb, {
      organizationId: "org-1",
      planCode: "free",
      subscriptionStatus: "free",
      paidThroughAt: null,
      paymentReference: "downgrade-ref-001",
      note: null,
      keptStripeLink: false,
      operatorSource: "cli",
    });
    expect(mockUpdateOrganizationBillingState).toHaveBeenCalledWith(
      expect.anything(),
      "org-1",
      expect.objectContaining({
        planCode: "free",
        subscriptionStatus: "free",
        stripeCustomerId: null,
        stripeSubscriptionId: null,
        paidThroughAt: null,
      }),
    );
  });

  it("clears trial and period fields when keptStripeLink is false", async () => {
    await grantManualOrganizationPlan(fakeDb, {
      organizationId: "org-1",
      planCode: "pro",
      subscriptionStatus: "active",
      paidThroughAt: PAID_THROUGH,
      paymentReference: "period-clear-ref-001",
      note: null,
      keptStripeLink: false,
      operatorSource: "cli",
    });
    expect(mockUpdateOrganizationBillingState).toHaveBeenCalledWith(
      expect.anything(),
      "org-1",
      expect.objectContaining({
        trialEndsAt: null,
        currentPeriodStart: null,
        currentPeriodEnd: null,
      }),
    );
  });

  it("keeps stripe ids when business + keptStripeLink", async () => {
    await grantManualOrganizationPlan(fakeDb, {
      organizationId: "org-1",
      planCode: "business",
      subscriptionStatus: "active",
      paidThroughAt: null,
      paymentReference: "keep-stripe-ref-001",
      note: null,
      keptStripeLink: true,
      operatorSource: "cli",
    });
    const call = mockUpdateOrganizationBillingState.mock.calls[0][2] as Record<string, unknown>;
    expect(call["stripeCustomerId"]).toBeUndefined();
    expect(call["stripeSubscriptionId"]).toBeUndefined();
  });

  it("idempotent: existing event for (org, payment_reference) returns idempotent: true and re-applies billing patch", async () => {
    mockFindOrCreateManualBillingEvent.mockResolvedValueOnce({
      event: {
        id: "event-existing",
        organizationId: "org-1",
        telegramUserId: null,
        planCode: "pro",
        subscriptionStatus: "active",
        paidThroughAt: PAID_THROUGH,
        paymentReference: "wise-2026-04-001",
        note: null,
        keptStripeLink: false,
        operatorSource: "cli",
      },
      created: false,
    });
    const result = await grantManualOrganizationPlan(fakeDb, {
      organizationId: "org-1",
      planCode: "pro",
      subscriptionStatus: "active",
      paidThroughAt: PAID_THROUGH,
      paymentReference: "wise-2026-04-001",
      note: null,
      keptStripeLink: false,
      operatorSource: "cli",
    });
    expect(result).toMatchObject({
      ok: true,
      idempotent: true,
      updated: false,
      planCode: "pro",
      manualBillingEventId: "event-existing",
    });
    expect(mockCreateManualBillingEvent).not.toHaveBeenCalled();
    expect(mockUpdateOrganizationBillingState).toHaveBeenCalledOnce();
  });

  it("returns payment_reference_conflict when same payref already used for a different org", async () => {
    // Simulate the global unique index blocking the insert for org-B, and the
    // third fallback in findOrCreateManualBillingEvent returning org-A's event.
    mockFindOrCreateManualBillingEvent.mockResolvedValueOnce({
      event: {
        id: "event-other-org",
        organizationId: "org-other", // different from the submitted org
        telegramUserId: null,
        planCode: "pro",
        subscriptionStatus: "active",
        paidThroughAt: PAID_THROUGH,
        paymentReference: "wise-cross-org-001",
        note: null,
        keptStripeLink: false,
        operatorSource: "cli",
      },
      created: false,
    });
    const result = await grantManualOrganizationPlan(fakeDb, {
      organizationId: "org-1", // different org from the stored event
      planCode: "pro",
      subscriptionStatus: "active",
      paidThroughAt: PAID_THROUGH,
      paymentReference: "wise-cross-org-001",
      note: null,
      keptStripeLink: false,
      operatorSource: "cli",
    });
    expect(result).toEqual({ ok: false, code: "payment_reference_conflict" });
    expect(mockUpdateOrganizationBillingState).not.toHaveBeenCalled();
  });

  it("idempotent replay with stale expectedUpdatedAt returns concurrent_update instead of reconciling", async () => {
    // Org has drifted (stale stripe IDs), but the caller's version token is stale too.
    // The version guard must fire to prevent rolling back newer state.
    const orgUpdatedAt = new Date("2026-03-01T00:00:00.000Z");
    mockFindOrganizationByIdForUpdate.mockResolvedValueOnce({
      id: "org-1",
      planCode: "free",
      subscriptionStatus: "free",
      stripeCustomerId: "cus_existing", // drift: should be null
      stripeSubscriptionId: null,
      paidThroughAt: null,
      trialEndsAt: null,
      currentPeriodStart: null,
      currentPeriodEnd: null,
      updatedAt: orgUpdatedAt,
    });
    mockFindOrCreateManualBillingEvent.mockResolvedValueOnce({
      event: {
        id: "event-existing",
        organizationId: "org-1",
        telegramUserId: null,
        planCode: "free",
        subscriptionStatus: "free",
        paidThroughAt: null,
        paymentReference: "version-replay-ref-001",
        note: null,
        keptStripeLink: false,
        operatorSource: "cli",
      },
      created: false,
    });
    const result = await grantManualOrganizationPlan(fakeDb, {
      organizationId: "org-1",
      planCode: "free",
      subscriptionStatus: "free",
      paidThroughAt: null,
      paymentReference: "version-replay-ref-001",
      note: null,
      keptStripeLink: false,
      operatorSource: "cli",
      expectedUpdatedAt: "2026-02-01T00:00:00.000Z", // stale: org.updatedAt is 2026-03-01
    });
    expect(result).toEqual({ ok: false, code: "concurrent_update" });
    expect(mockUpdateOrganizationBillingState).not.toHaveBeenCalled();
  });

  it("idempotent replay with matching expectedUpdatedAt reconciles normally", async () => {
    const orgUpdatedAt = new Date("2026-03-01T00:00:00.000Z");
    mockFindOrganizationByIdForUpdate.mockResolvedValueOnce({
      id: "org-1",
      planCode: "free",
      subscriptionStatus: "free",
      stripeCustomerId: "cus_existing", // drift
      stripeSubscriptionId: null,
      paidThroughAt: null,
      trialEndsAt: null,
      currentPeriodStart: null,
      currentPeriodEnd: null,
      updatedAt: orgUpdatedAt,
    });
    mockFindOrCreateManualBillingEvent.mockResolvedValueOnce({
      event: {
        id: "event-existing",
        organizationId: "org-1",
        telegramUserId: null,
        planCode: "free",
        subscriptionStatus: "free",
        paidThroughAt: null,
        paymentReference: "version-replay-ref-002",
        note: null,
        keptStripeLink: false,
        operatorSource: "cli",
      },
      created: false,
    });
    const result = await grantManualOrganizationPlan(fakeDb, {
      organizationId: "org-1",
      planCode: "free",
      subscriptionStatus: "free",
      paidThroughAt: null,
      paymentReference: "version-replay-ref-002",
      note: null,
      keptStripeLink: false,
      operatorSource: "cli",
      expectedUpdatedAt: "2026-03-01T00:00:00.000Z", // matches
    });
    expect(result).toMatchObject({ ok: true, idempotent: true, reconciled: true });
    expect(mockUpdateOrganizationBillingState).toHaveBeenCalledOnce();
  });

  it("idempotent replay reconciles when org has stale period fields despite matching plan/status", async () => {
    // Simulate an org that already has the right plan/status/paidThrough and cleared Stripe IDs
    // but still has a stale currentPeriodEnd from a previous Stripe subscription.
    mockFindOrganizationByIdForUpdate.mockResolvedValueOnce({
      id: "org-1",
      planCode: "pro",
      subscriptionStatus: "active",
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      paidThroughAt: PAID_THROUGH,
      currentPeriodEnd: new Date("2026-06-01T00:00:00.000Z"), // stale Stripe field
      trialEndsAt: null,
      currentPeriodStart: null,
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    mockFindOrCreateManualBillingEvent.mockResolvedValueOnce({
      event: {
        id: "event-existing",
        organizationId: "org-1",
        telegramUserId: null,
        planCode: "pro",
        subscriptionStatus: "active",
        paidThroughAt: PAID_THROUGH,
        paymentReference: "stale-period-ref-001",
        note: null,
        keptStripeLink: false,
        operatorSource: "cli",
      },
      created: false,
    });
    const result = await grantManualOrganizationPlan(fakeDb, {
      organizationId: "org-1",
      planCode: "pro",
      subscriptionStatus: "active",
      paidThroughAt: PAID_THROUGH,
      paymentReference: "stale-period-ref-001",
      note: null,
      keptStripeLink: false,
      operatorSource: "cli",
    });
    expect(result).toMatchObject({ ok: true, idempotent: true, reconciled: true });
    expect(mockUpdateOrganizationBillingState).toHaveBeenCalledOnce();
    expect(mockUpdateOrganizationBillingState).toHaveBeenCalledWith(
      expect.anything(),
      "org-1",
      expect.objectContaining({ currentPeriodEnd: null }),
    );
  });

  it("returns payment_reference_conflict when same reference is resubmitted with different billing fields", async () => {
    mockFindOrCreateManualBillingEvent.mockResolvedValueOnce({
      event: {
        id: "event-existing",
        organizationId: "org-1",
        telegramUserId: null,
        planCode: "personal",
        subscriptionStatus: "active",
        paidThroughAt: new Date("2026-05-10T00:00:00.000Z"),
        paymentReference: "wise-2026-04-001",
        note: null,
        keptStripeLink: false,
        operatorSource: "cli",
      },
      created: false,
    });
    const result = await grantManualOrganizationPlan(fakeDb, {
      organizationId: "org-1",
      planCode: "pro",
      subscriptionStatus: "active",
      paidThroughAt: PAID_THROUGH,
      paymentReference: "wise-2026-04-001",
      note: null,
      keptStripeLink: false,
      operatorSource: "cli",
    });
    expect(result).toEqual({ ok: false, code: "payment_reference_conflict" });
    expect(mockUpdateOrganizationBillingState).not.toHaveBeenCalled();
  });

  it("returns payment_reference_conflict when org-grant reuses payref with a different telegramUserId", async () => {
    mockFindOrCreateManualBillingEvent.mockResolvedValueOnce({
      event: {
        id: "event-existing",
        organizationId: "org-1",
        telegramUserId: 111n,
        planCode: "pro",
        subscriptionStatus: "active",
        paidThroughAt: PAID_THROUGH,
        paymentReference: "wise-2026-04-002",
        note: null,
        keptStripeLink: false,
        operatorSource: "cli",
      },
      created: false,
    });
    const result = await grantManualOrganizationPlan(fakeDb, {
      organizationId: "org-1",
      telegramUserId: 222n,
      planCode: "pro",
      subscriptionStatus: "active",
      paidThroughAt: PAID_THROUGH,
      paymentReference: "wise-2026-04-002",
      note: null,
      keptStripeLink: false,
      operatorSource: "cli",
    });
    expect(result).toEqual({ ok: false, code: "payment_reference_conflict" });
    expect(mockUpdateOrganizationBillingState).not.toHaveBeenCalled();
  });

  it("idempotent replay returns the stored event's operatorSource, not the caller's", async () => {
    mockFindOrCreateManualBillingEvent.mockResolvedValueOnce({
      event: {
        id: "event-existing",
        organizationId: "org-1",
        telegramUserId: null,
        planCode: "pro",
        subscriptionStatus: "active",
        paidThroughAt: PAID_THROUGH,
        paymentReference: "wise-2026-04-001",
        note: null,
        keptStripeLink: false,
        operatorSource: "cli",
      },
      created: false,
    });
    const result = await grantManualOrganizationPlan(fakeDb, {
      organizationId: "org-1",
      planCode: "pro",
      subscriptionStatus: "active",
      paidThroughAt: PAID_THROUGH,
      paymentReference: "wise-2026-04-001",
      note: null,
      keptStripeLink: false,
      operatorSource: "admin:abcdef1234567890",
    });
    expect(result).toMatchObject({
      ok: true,
      idempotent: true,
      operatorSource: "cli",
    });
  });

  it("returns payment_reference_conflict when org-grant reuses payref with a different note", async () => {
    mockFindOrCreateManualBillingEvent.mockResolvedValueOnce({
      event: {
        id: "event-existing",
        organizationId: "org-1",
        telegramUserId: null,
        planCode: "pro",
        subscriptionStatus: "active",
        paidThroughAt: PAID_THROUGH,
        paymentReference: "wise-2026-04-001",
        note: "original note",
        keptStripeLink: false,
        operatorSource: "cli",
      },
      created: false,
    });
    const result = await grantManualOrganizationPlan(fakeDb, {
      organizationId: "org-1",
      planCode: "pro",
      subscriptionStatus: "active",
      paidThroughAt: PAID_THROUGH,
      paymentReference: "wise-2026-04-001",
      note: "different note",
      keptStripeLink: false,
      operatorSource: "cli",
    });
    expect(result).toEqual({ ok: false, code: "payment_reference_conflict" });
    expect(mockUpdateOrganizationBillingState).not.toHaveBeenCalled();
  });

  it("rejects paymentReference longer than 255 characters at service layer", async () => {
    const result = await grantManualOrganizationPlan(fakeDb, {
      organizationId: "org-1",
      planCode: "pro",
      subscriptionStatus: "active",
      paidThroughAt: PAID_THROUGH,
      paymentReference: "x".repeat(256),
      note: null,
      keptStripeLink: false,
      operatorSource: "cli",
    });
    expect(result).toEqual({ ok: false, code: "payment_reference_too_long" });
    expect(mockUpdateOrganizationBillingState).not.toHaveBeenCalled();
  });

  it("rejects note longer than 1000 characters at service layer", async () => {
    const result = await grantManualOrganizationPlan(fakeDb, {
      organizationId: "org-1",
      planCode: "pro",
      subscriptionStatus: "active",
      paidThroughAt: PAID_THROUGH,
      paymentReference: "ref-001",
      note: "n".repeat(1001),
      keptStripeLink: false,
      operatorSource: "cli",
    });
    expect(result).toEqual({ ok: false, code: "note_too_long" });
    expect(mockUpdateOrganizationBillingState).not.toHaveBeenCalled();
  });
});

describe("grantManualUserPlan", () => {
  it("returns ambiguous_organization when createNewOrganization=true and organizationId is also set", async () => {
    const result = await grantManualUserPlan(fakeDb, {
      telegramUserId: 12345n,
      planCode: "pro",
      subscriptionStatus: "active",
      paidThroughAt: PAID_THROUGH,
      paymentReference: "ref-conflict",
      note: null,
      keptStripeLink: false,
      organizationId: "org-1",
      createNewOrganization: true,
      operatorSource: "cli",
    });
    expect(result).toEqual({ ok: false, code: "ambiguous_organization" });
    expect(mockUpdateOrganizationBillingState).not.toHaveBeenCalled();
  });

  it("creates a new user/org/owner-membership when user has no memberships", async () => {
    mockListOrganizationMembershipsForUser.mockResolvedValue([]);
    mockCreateOrganization.mockResolvedValueOnce({
      id: "org-new",
      name: "Telegram 12345",
      planCode: "free",
      subscriptionStatus: "free",
      stripeCustomerId: null,
      stripeSubscriptionId: null,
    });
    // After create, the org lookup (FOR UPDATE) for the grant should succeed
    mockFindOrganizationByIdForUpdate.mockResolvedValueOnce({
      id: "org-new",
      name: "Telegram 12345",
      planCode: "free",
      subscriptionStatus: "free",
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      paidThroughAt: null,
      updatedAt: new Date(),
    });
    mockUpdateOrganizationBillingState.mockResolvedValueOnce({
      id: "org-new",
      planCode: "personal",
      subscriptionStatus: "active",
      paidThroughAt: PAID_THROUGH,
      stripeCustomerId: null,
      stripeSubscriptionId: null,
    });

    const result = await grantManualUserPlan(fakeDb, {
      telegramUserId: 12345n,
      planCode: "personal",
      subscriptionStatus: "active",
      paidThroughAt: PAID_THROUGH,
      paymentReference: "user-plan-ref-001",
      note: null,
      keptStripeLink: false,
      organizationId: null,
      createNewOrganization: false,
      operatorSource: "cli",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.createdOrganization).toBe(true);
    expect(result.organizationId).toBe("org-new");
    expect(mockCreateOrganization).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ name: "Telegram 12345" }),
    );
    expect(mockAddOrganizationMember).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ organizationId: "org-new", userId: 12345n, role: "owner" }),
    );
  });

  it("uses the single existing owner/admin organization when one exists", async () => {
    mockListOrganizationMembershipsForUser.mockResolvedValue([
      { organizationId: "org-1", userId: 12345n, role: "owner" },
    ]);

    const result = await grantManualUserPlan(fakeDb, {
      telegramUserId: 12345n,
      planCode: "pro",
      subscriptionStatus: "active",
      paidThroughAt: PAID_THROUGH,
      paymentReference: "user-plan-ref-001",
      note: null,
      keptStripeLink: false,
      organizationId: null,
      createNewOrganization: false,
      operatorSource: "cli",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.createdOrganization).toBe(false);
    expect(result.organizationId).toBe("org-1");
    expect(mockCreateOrganization).not.toHaveBeenCalled();
  });

  it("refuses when multiple owner/admin orgs exist without --organization-id", async () => {
    mockListOrganizationMembershipsForUser.mockResolvedValue([
      { organizationId: "org-1", userId: 12345n, role: "owner" },
      { organizationId: "org-2", userId: 12345n, role: "admin" },
    ]);

    const result = await grantManualUserPlan(fakeDb, {
      telegramUserId: 12345n,
      planCode: "pro",
      subscriptionStatus: "active",
      paidThroughAt: PAID_THROUGH,
      paymentReference: "user-plan-ref-001",
      note: null,
      keptStripeLink: false,
      organizationId: null,
      createNewOrganization: false,
      operatorSource: "cli",
    });

    expect(result).toMatchObject({ ok: false, code: "ambiguous_organization" });
    if (result.ok) return;
    expect(result.organizationIds).toEqual(["org-1", "org-2"]);
  });

  it("refuses member-only memberships without explicit override", async () => {
    mockListOrganizationMembershipsForUser.mockResolvedValue([
      { organizationId: "org-1", userId: 12345n, role: "member" },
    ]);

    const result = await grantManualUserPlan(fakeDb, {
      telegramUserId: 12345n,
      planCode: "pro",
      subscriptionStatus: "active",
      paidThroughAt: PAID_THROUGH,
      paymentReference: "user-plan-ref-001",
      note: null,
      keptStripeLink: false,
      organizationId: null,
      createNewOrganization: false,
      operatorSource: "cli",
    });

    expect(result).toMatchObject({ ok: false, code: "member_only_memberships" });
  });

  it("createNewOrganization=true forces a new org even when memberships exist", async () => {
    mockListOrganizationMembershipsForUser.mockResolvedValue([
      { organizationId: "org-1", userId: 12345n, role: "member" },
    ]);
    mockCreateOrganization.mockResolvedValueOnce({ id: "org-2", name: "Telegram 12345" });
    mockFindOrganizationByIdForUpdate.mockResolvedValueOnce({
      id: "org-2",
      planCode: "free",
      subscriptionStatus: "free",
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      paidThroughAt: null,
      updatedAt: new Date(),
    });

    const result = await grantManualUserPlan(fakeDb, {
      telegramUserId: 12345n,
      planCode: "pro",
      subscriptionStatus: "active",
      paidThroughAt: PAID_THROUGH,
      paymentReference: "user-plan-ref-001",
      note: null,
      keptStripeLink: false,
      organizationId: null,
      createNewOrganization: true,
      operatorSource: "cli",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.createdOrganization).toBe(true);
    expect(result.organizationId).toBe("org-2");
  });

  it("explicit --organization-id requires user to be owner/admin", async () => {
    mockUserHasOrganizationRole.mockResolvedValueOnce(false);

    const result = await grantManualUserPlan(fakeDb, {
      telegramUserId: 12345n,
      planCode: "pro",
      subscriptionStatus: "active",
      paidThroughAt: PAID_THROUGH,
      paymentReference: "user-plan-ref-001",
      note: null,
      keptStripeLink: false,
      organizationId: "org-x",
      createNewOrganization: false,
      operatorSource: "cli",
    });

    expect(result).toMatchObject({ ok: false, code: "user_not_in_organization" });
  });

  it("returns payment_reference_conflict when same paymentReference used for a different org", async () => {
    const existingEvent = {
      id: "event-existing",
      organizationId: "org-original",
      telegramUserId: 12345n,
      planCode: "pro",
      subscriptionStatus: "active",
      paidThroughAt: PAID_THROUGH,
      paymentReference: "wise-ref-conflict",
      note: null,
      keptStripeLink: false,
      operatorSource: "cli",
    };
    mockFindManualBillingEventByUserAndPaymentReference.mockResolvedValueOnce(existingEvent);

    const result = await grantManualUserPlan(fakeDb, {
      telegramUserId: 12345n,
      planCode: "pro",
      subscriptionStatus: "active",
      paidThroughAt: PAID_THROUGH,
      paymentReference: "wise-ref-conflict",
      note: null,
      keptStripeLink: false,
      organizationId: "org-different", // different from the existing event's org
      createNewOrganization: false,
      operatorSource: "cli",
    });

    expect(result).toMatchObject({ ok: false, code: "payment_reference_conflict" });
    expect(mockUpdateOrganizationBillingState).not.toHaveBeenCalled();
  });

  it("returns payment_reference_conflict when same user reference is resubmitted with different billing fields", async () => {
    const existingEvent = {
      id: "event-existing",
      organizationId: "org-1",
      telegramUserId: 12345n,
      planCode: "personal",
      subscriptionStatus: "active",
      paidThroughAt: new Date("2026-05-10T00:00:00.000Z"),
      paymentReference: "wise-ref-mismatch",
      note: null,
      keptStripeLink: false,
      operatorSource: "cli",
    };
    mockFindManualBillingEventByUserAndPaymentReference.mockResolvedValueOnce(existingEvent);

    const result = await grantManualUserPlan(fakeDb, {
      telegramUserId: 12345n,
      planCode: "pro",
      subscriptionStatus: "active",
      paidThroughAt: PAID_THROUGH,
      paymentReference: "wise-ref-mismatch",
      note: null,
      keptStripeLink: false,
      organizationId: null,
      createNewOrganization: false,
      operatorSource: "cli",
    });

    expect(result).toEqual({ ok: false, code: "payment_reference_conflict" });
    expect(mockUpdateOrganizationBillingState).not.toHaveBeenCalled();
  });

  it("idempotent replay when explicit organizationId matches existing event", async () => {
    const existingEvent = {
      id: "event-existing",
      organizationId: "org-1",
      telegramUserId: 12345n,
      planCode: "pro",
      subscriptionStatus: "active",
      paidThroughAt: PAID_THROUGH,
      paymentReference: "wise-retry-explicit-ref",
      note: null,
      keptStripeLink: false,
      operatorSource: "cli",
    };
    mockFindManualBillingEventByUserAndPaymentReference.mockResolvedValueOnce(existingEvent);

    const result = await grantManualUserPlan(fakeDb, {
      telegramUserId: 12345n,
      planCode: "pro",
      subscriptionStatus: "active",
      paidThroughAt: PAID_THROUGH,
      paymentReference: "wise-retry-explicit-ref",
      note: null,
      keptStripeLink: false,
      organizationId: "org-1",
      createNewOrganization: false,
      operatorSource: "cli",
    });

    expect(result).toMatchObject({
      ok: true,
      idempotent: true,
      updated: false,
      createdOrganization: false,
      organizationId: "org-1",
    });
    expect(mockUpdateOrganizationBillingState).toHaveBeenCalledOnce();
  });

  it("idempotent replay when createNewOrganization=true and same paymentReference reused", async () => {
    const existingEvent = {
      id: "event-existing",
      organizationId: "org-original",
      telegramUserId: 12345n,
      planCode: "personal",
      subscriptionStatus: "active",
      paidThroughAt: PAID_THROUGH,
      paymentReference: "wise-retry-ref-001",
      note: null,
      keptStripeLink: false,
      operatorSource: "cli",
    };
    mockFindManualBillingEventByUserAndPaymentReference.mockResolvedValueOnce(existingEvent);

    const result = await grantManualUserPlan(fakeDb, {
      telegramUserId: 12345n,
      planCode: "personal",
      subscriptionStatus: "active",
      paidThroughAt: PAID_THROUGH,
      paymentReference: "wise-retry-ref-001",
      note: null,
      keptStripeLink: false,
      organizationId: null,
      createNewOrganization: true,
      operatorSource: "cli",
    });

    expect(result).toMatchObject({
      ok: true,
      idempotent: true,
      updated: false,
      createdOrganization: false,
      organizationId: "org-original",
      manualBillingEventId: "event-existing",
    });
    // Must not create a second org
    expect(mockCreateOrganization).not.toHaveBeenCalled();
    expect(mockUpdateOrganizationBillingState).toHaveBeenCalledOnce();
  });

  it("idempotent replay when no memberships and same paymentReference reused", async () => {
    mockListOrganizationMembershipsForUser.mockResolvedValue([]);
    const existingEvent = {
      id: "event-existing",
      organizationId: "org-original",
      telegramUserId: 12345n,
      planCode: "pro",
      subscriptionStatus: "active",
      paidThroughAt: PAID_THROUGH,
      paymentReference: "wise-retry-ref-002",
      note: null,
      keptStripeLink: false,
      operatorSource: "cli",
    };
    mockFindManualBillingEventByUserAndPaymentReference.mockResolvedValueOnce(existingEvent);

    const result = await grantManualUserPlan(fakeDb, {
      telegramUserId: 12345n,
      planCode: "pro",
      subscriptionStatus: "active",
      paidThroughAt: PAID_THROUGH,
      paymentReference: "wise-retry-ref-002",
      note: null,
      keptStripeLink: false,
      organizationId: null,
      createNewOrganization: false,
      operatorSource: "cli",
    });

    expect(result).toMatchObject({
      ok: true,
      idempotent: true,
      updated: false,
      createdOrganization: false,
      organizationId: "org-original",
    });
    expect(mockCreateOrganization).not.toHaveBeenCalled();
    expect(mockUpdateOrganizationBillingState).toHaveBeenCalledOnce();
  });

  it("rolls back newly created org when concurrent request wins the event race", async () => {
    const canonicalEvent = {
      id: "event-winner",
      organizationId: "org-winner",
      telegramUserId: 12345n,
      planCode: "personal",
      subscriptionStatus: "active",
      paidThroughAt: PAID_THROUGH,
      paymentReference: "race-ref-001",
      note: null,
      keptStripeLink: false,
      operatorSource: "cli",
    };
    // Pre-check (inside tx): no existing event yet
    mockFindManualBillingEventByUserAndPaymentReference.mockResolvedValueOnce(null);
    // Recovery (outside tx): winning event from the concurrent transaction
    mockFindManualBillingEventByUserAndPaymentReference.mockResolvedValueOnce(canonicalEvent);
    mockCreateOrganization.mockResolvedValueOnce({ id: "org-loser" });
    mockFindOrganizationByIdForUpdate.mockResolvedValueOnce({
      id: "org-loser",
      updatedAt: new Date(),
    });
    // Concurrent winner already committed — our insert loses
    mockFindOrCreateManualBillingEvent.mockResolvedValueOnce({
      event: canonicalEvent,
      created: false,
    });

    const result = await grantManualUserPlan(fakeDb, {
      telegramUserId: 12345n,
      planCode: "personal",
      subscriptionStatus: "active",
      paidThroughAt: PAID_THROUGH,
      paymentReference: "race-ref-001",
      note: null,
      keptStripeLink: false,
      organizationId: null,
      createNewOrganization: true,
      operatorSource: "cli",
    });

    expect(result).toMatchObject({
      ok: true,
      idempotent: true,
      updated: false,
      reconciled: true,
      createdOrganization: false,
      organizationId: "org-winner",
      manualBillingEventId: "event-winner",
    });
    expect(mockUpdateOrganizationBillingState).toHaveBeenCalledOnce();
  });

  it("returns payment_reference_conflict when post-insert replay lands in a different org", async () => {
    // Pre-check sees no event (no Once override — default null).
    // User has explicit org-A, but a concurrent tx already committed the event in org-B.
    const winnerEvent = {
      id: "event-winner",
      organizationId: "org-B",
      telegramUserId: 12345n,
      planCode: "pro",
      subscriptionStatus: "active",
      paidThroughAt: PAID_THROUGH,
      paymentReference: "conflict-ref-002",
      note: null,
      keptStripeLink: false,
      operatorSource: "cli",
    };
    mockUserHasOrganizationRole.mockResolvedValueOnce(true);
    mockFindOrganizationByIdForUpdate.mockResolvedValueOnce({
      id: "org-A",
      updatedAt: new Date(),
    });
    // Insert blocked by user-scoped unique index; fallback returns winner's event
    mockFindOrCreateManualBillingEvent.mockResolvedValueOnce({
      event: winnerEvent,
      created: false,
    });

    const result = await grantManualUserPlan(fakeDb, {
      telegramUserId: 12345n,
      planCode: "pro",
      subscriptionStatus: "active",
      paidThroughAt: PAID_THROUGH,
      paymentReference: "conflict-ref-002",
      note: null,
      keptStripeLink: false,
      organizationId: "org-A",
      createNewOrganization: false,
      operatorSource: "cli",
    });

    expect(result).toMatchObject({ ok: false, code: "payment_reference_conflict" });
    expect(mockUpdateOrganizationBillingState).not.toHaveBeenCalled();
  });

  it("returns payment_reference_conflict when post-insert replay belongs to a different telegramUserId", async () => {
    // Same org and payref but winner's event was created by a different user (111n vs 222n).
    const winnerEvent = {
      id: "event-winner",
      organizationId: "org-1",
      telegramUserId: 111n,
      planCode: "pro",
      subscriptionStatus: "active",
      paidThroughAt: PAID_THROUGH,
      paymentReference: "shared-ref-001",
      note: null,
      keptStripeLink: false,
      operatorSource: "cli",
    };
    mockUserHasOrganizationRole.mockResolvedValueOnce(true);
    mockFindOrganizationByIdForUpdate.mockResolvedValueOnce({ id: "org-1", updatedAt: new Date() });
    mockFindOrCreateManualBillingEvent.mockResolvedValueOnce({
      event: winnerEvent,
      created: false,
    });

    const result = await grantManualUserPlan(fakeDb, {
      telegramUserId: 222n,
      planCode: "pro",
      subscriptionStatus: "active",
      paidThroughAt: PAID_THROUGH,
      paymentReference: "shared-ref-001",
      note: null,
      keptStripeLink: false,
      organizationId: "org-1",
      createNewOrganization: false,
      operatorSource: "cli",
    });

    expect(result).toEqual({ ok: false, code: "payment_reference_conflict" });
    expect(mockUpdateOrganizationBillingState).not.toHaveBeenCalled();
  });

  it("post-insert idempotent replay re-applies billing patch to restore drifted org state", async () => {
    const winnerEvent = {
      id: "event-winner",
      organizationId: "org-1",
      telegramUserId: 12345n,
      planCode: "pro",
      subscriptionStatus: "active",
      paidThroughAt: PAID_THROUGH,
      paymentReference: "drift-ref-001",
      note: null,
      keptStripeLink: false,
      operatorSource: "cli",
    };
    mockUserHasOrganizationRole.mockResolvedValueOnce(true);
    mockFindOrganizationByIdForUpdate.mockResolvedValueOnce({ id: "org-1", updatedAt: new Date() });
    // Concurrent winner already committed — our insert loses
    mockFindOrCreateManualBillingEvent.mockResolvedValueOnce({
      event: winnerEvent,
      created: false,
    });

    const result = await grantManualUserPlan(fakeDb, {
      telegramUserId: 12345n,
      planCode: "pro",
      subscriptionStatus: "active",
      paidThroughAt: PAID_THROUGH,
      paymentReference: "drift-ref-001",
      note: null,
      keptStripeLink: false,
      organizationId: "org-1",
      createNewOrganization: false,
      operatorSource: "cli",
    });

    expect(result).toMatchObject({
      ok: true,
      idempotent: true,
      updated: false,
      createdOrganization: false,
      organizationId: "org-1",
    });
    expect(mockUpdateOrganizationBillingState).toHaveBeenCalledOnce();
  });

  it("OrgCreationRaceSignal recovery returns conflict when canonical event has payload mismatch", async () => {
    const canonicalEvent = {
      id: "event-winner",
      organizationId: "org-winner",
      telegramUserId: 12345n,
      planCode: "personal",
      subscriptionStatus: "active",
      paidThroughAt: new Date("2026-05-10T00:00:00.000Z"),
      paymentReference: "race-mismatch-ref",
      note: null,
      keptStripeLink: false,
      operatorSource: "cli",
    };
    mockFindManualBillingEventByUserAndPaymentReference.mockResolvedValueOnce(null);
    mockFindManualBillingEventByUserAndPaymentReference.mockResolvedValueOnce(canonicalEvent);
    mockCreateOrganization.mockResolvedValueOnce({ id: "org-loser" });
    mockFindOrganizationByIdForUpdate.mockResolvedValueOnce({
      id: "org-loser",
      updatedAt: new Date(),
    });
    mockFindOrCreateManualBillingEvent.mockResolvedValueOnce({
      event: canonicalEvent,
      created: false,
    });

    const result = await grantManualUserPlan(fakeDb, {
      telegramUserId: 12345n,
      planCode: "pro",
      subscriptionStatus: "active",
      paidThroughAt: PAID_THROUGH,
      paymentReference: "race-mismatch-ref",
      note: null,
      keptStripeLink: false,
      organizationId: null,
      createNewOrganization: true,
      operatorSource: "cli",
    });

    expect(result).toEqual({ ok: false, code: "payment_reference_conflict" });
    expect(mockUpdateOrganizationBillingState).not.toHaveBeenCalled();
  });
});

describe("addManualOrganizationMember", () => {
  it("upserts user and adds membership without billing mutation", async () => {
    mockFindOrganizationById.mockResolvedValueOnce({ id: "org-1" });

    const result = await addManualOrganizationMember(fakeDb, {
      organizationId: "org-1",
      telegramUserId: 999n,
      role: "member",
    });

    expect(result).toEqual({
      ok: true,
      organizationId: "org-1",
      telegramUserId: "999",
      role: "member",
    });
    expect(mockFindOrCreateUserById).toHaveBeenCalledWith(expect.anything(), 999n);
    expect(mockAddOrganizationMember).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ organizationId: "org-1", userId: 999n, role: "member" }),
    );
    expect(mockUpdateOrganizationBillingState).not.toHaveBeenCalled();
    expect(mockCreateManualBillingEvent).not.toHaveBeenCalled();
  });

  it("rejects when organization is not found", async () => {
    mockFindOrganizationById.mockResolvedValueOnce(null);
    const result = await addManualOrganizationMember(fakeDb, {
      organizationId: "missing",
      telegramUserId: 1n,
      role: "member",
    });
    expect(result).toEqual({ ok: false, code: "organization_not_found" });
    expect(mockAddOrganizationMember).not.toHaveBeenCalled();
  });

  it("rejects invalid role values", async () => {
    const result = await addManualOrganizationMember(fakeDb, {
      organizationId: "org-1",
      telegramUserId: 1n,
      role: "superuser" as never,
    });
    expect(result).toEqual({ ok: false, code: "invalid_role" });
  });
});
