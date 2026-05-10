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
const mockFindManualBillingEventByPaymentReference = vi.fn();
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
  findManualBillingEventByPaymentReference: (...args: unknown[]): unknown =>
    mockFindManualBillingEventByPaymentReference(...args),
  findOrCreateManualBillingEvent: (...args: unknown[]): unknown =>
    mockFindOrCreateManualBillingEvent(...args),
}));

const fakeDb = {
  transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work({})),
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
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
  mockFindOrganizationById.mockResolvedValue(defaultOrg);
  mockFindOrganizationByIdForUpdate.mockResolvedValue(defaultOrg);
  mockFindManualBillingEventByPaymentReference.mockResolvedValue(null);
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
      paymentReference: null,
      note: null,
      keptStripeLink: false,
      operatorSource: "cli",
    });
    expect(result).toEqual({ ok: false, code: "organization_not_found" });
    expect(mockUpdateOrganizationBillingState).not.toHaveBeenCalled();
    expect(mockCreateManualBillingEvent).not.toHaveBeenCalled();
  });

  it("rejects keep_stripe_link for non-business plans", async () => {
    const result = await grantManualOrganizationPlan(fakeDb, {
      organizationId: "org-1",
      planCode: "pro",
      subscriptionStatus: "active",
      paidThroughAt: PAID_THROUGH,
      paymentReference: null,
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
      paymentReference: null,
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
      paymentReference: null,
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
      paymentReference: null,
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
      paymentReference: null,
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

  it("rejects paid plan with free subscription status at service layer", async () => {
    const result = await grantManualOrganizationPlan(fakeDb, {
      organizationId: "org-1",
      planCode: "pro",
      subscriptionStatus: "free",
      paidThroughAt: null,
      paymentReference: null,
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
    mockCreateManualBillingEvent.mockResolvedValue({ id: "evt-123" });

    const result = await grantManualOrganizationPlan(fakeDb, {
      organizationId: "org-1",
      planCode: "pro",
      subscriptionStatus: "active",
      paidThroughAt: new Date("2026-12-31"),
      paymentReference: null,
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
      paymentReference: null,
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

  it("keeps stripe ids when business + keptStripeLink", async () => {
    await grantManualOrganizationPlan(fakeDb, {
      organizationId: "org-1",
      planCode: "business",
      subscriptionStatus: "active",
      paidThroughAt: null,
      paymentReference: null,
      note: null,
      keptStripeLink: true,
      operatorSource: "cli",
    });
    const call = mockUpdateOrganizationBillingState.mock.calls[0][2] as Record<string, unknown>;
    expect(call["stripeCustomerId"]).toBeUndefined();
    expect(call["stripeSubscriptionId"]).toBeUndefined();
  });

  it("idempotent: existing event for (org, payment_reference) returns idempotent: true without mutating billing state", async () => {
    mockFindOrCreateManualBillingEvent.mockResolvedValueOnce({
      event: {
        id: "event-existing",
        organizationId: "org-1",
        telegramUserId: null,
        planCode: "personal",
        subscriptionStatus: "active",
        paidThroughAt: new Date("2026-05-10T00:00:00.000Z"),
        paymentReference: "wise-2026-04-001",
        note: "Original grant",
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
      planCode: "personal",
      paidThroughAt: "2026-05-10T00:00:00.000Z",
      note: "Original grant",
      manualBillingEventId: "event-existing",
    });
    expect(mockCreateManualBillingEvent).not.toHaveBeenCalled();
    // Idempotent path must NOT mutate billing state
    expect(mockUpdateOrganizationBillingState).not.toHaveBeenCalled();
  });

  it("idempotent replay uses the current caller's operatorSource, not the stored event's", async () => {
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
      operatorSource: "admin:abcdef1234567890",
    });
    expect(result).toMatchObject({
      ok: true,
      idempotent: true,
      operatorSource: "admin:abcdef1234567890",
    });
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
    // After create, the org lookup for the grant should succeed
    mockFindOrganizationById.mockResolvedValueOnce({
      id: "org-new",
      name: "Telegram 12345",
      planCode: "free",
      subscriptionStatus: "free",
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      paidThroughAt: null,
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
      paymentReference: null,
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
      paymentReference: null,
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
      paymentReference: null,
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
      paymentReference: null,
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
    mockFindOrganizationById.mockResolvedValueOnce({
      id: "org-2",
      planCode: "free",
      subscriptionStatus: "free",
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      paidThroughAt: null,
    });

    const result = await grantManualUserPlan(fakeDb, {
      telegramUserId: 12345n,
      planCode: "pro",
      subscriptionStatus: "active",
      paidThroughAt: PAID_THROUGH,
      paymentReference: null,
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
      paymentReference: null,
      note: null,
      keptStripeLink: false,
      organizationId: "org-x",
      createNewOrganization: false,
      operatorSource: "cli",
    });

    expect(result).toMatchObject({ ok: false, code: "user_not_in_organization" });
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
