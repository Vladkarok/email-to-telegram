import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFindOrCreateUserById = vi.fn();
const mockFindUserByIdForUpdate = vi.fn();
const mockUpdateUserBillingState = vi.fn();
vi.mock("../../../src/db/repos/users.js", () => ({
  findOrCreateUserById: (...args: unknown[]): unknown => mockFindOrCreateUserById(...args),
  findUserByIdForUpdate: (...args: unknown[]): unknown => mockFindUserByIdForUpdate(...args),
  updateUserBillingState: (...args: unknown[]): unknown => mockUpdateUserBillingState(...args),
}));

const mockFindManualBillingEventByUserAndPaymentReference = vi.fn();
const mockFindOrCreateManualBillingEvent = vi.fn();
vi.mock("../../../src/db/repos/manualBillingEvents.js", () => ({
  findManualBillingEventByUserAndPaymentReference: (...args: unknown[]): unknown =>
    mockFindManualBillingEventByUserAndPaymentReference(...args),
  findOrCreateManualBillingEvent: (...args: unknown[]): unknown =>
    mockFindOrCreateManualBillingEvent(...args),
}));

const mockRecordManualPlanGrant = vi.fn();
vi.mock("../../../src/observability/metrics.js", () => ({
  recordManualPlanGrant: (...args: unknown[]): unknown => mockRecordManualPlanGrant(...args),
}));

const { grantManualUserPlan } = await import("../../../src/billing/manual.js");

function buildDb() {
  const execute = vi.fn().mockResolvedValue(undefined);
  return {
    tx: { execute },
    db: {
      transaction: vi.fn(async (work: (tx: { execute: typeof execute }) => Promise<unknown>) =>
        work({ execute }),
      ),
    } as never,
  };
}

function user(overrides: Record<string, unknown> = {}) {
  return {
    id: 123n,
    planCode: "free",
    subscriptionStatus: "free",
    paidThroughAt: null,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    trialEndsAt: null,
    currentPeriodStart: null,
    currentPeriodEnd: null,
    updatedAt: new Date("2026-05-18T10:00:00.000Z"),
    ...overrides,
  };
}

describe("grantManualUserPlan", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindOrCreateUserById.mockResolvedValue(user());
    mockFindUserByIdForUpdate.mockResolvedValue(user());
    mockFindManualBillingEventByUserAndPaymentReference.mockResolvedValue(null);
    mockFindOrCreateManualBillingEvent.mockResolvedValue({
      created: true,
      event: { id: "event-1", telegramUserId: 123n },
    });
    mockUpdateUserBillingState.mockResolvedValue(user({ planCode: "pro" }));
  });

  it("creates a user-keyed manual billing event and updates billing state", async () => {
    const { db, tx } = buildDb();
    const paidThroughAt = new Date("2026-06-30T00:00:00.000Z");

    const result = await grantManualUserPlan(db, {
      telegramUserId: 123n,
      planCode: "pro",
      subscriptionStatus: "active",
      paidThroughAt,
      paymentReference: " wise-123 ",
      note: " paid by Wise ",
      keptStripeLink: false,
      operatorSource: "cli",
      expectedUpdatedAt: "2026-05-18T10:00:00.000Z",
    });

    expect(result).toMatchObject({
      ok: true,
      idempotent: false,
      updated: true,
      telegramUserId: "123",
      paymentReference: "wise-123",
      note: "paid by Wise",
    });
    expect(tx.execute).toHaveBeenCalledWith(expect.anything());
    expect(mockFindOrCreateManualBillingEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        telegramUserId: 123n,
        paymentReference: "wise-123",
        operatorSource: "cli",
      }),
    );
    expect(mockUpdateUserBillingState).toHaveBeenCalledWith(
      expect.anything(),
      123n,
      expect.objectContaining({
        planCode: "pro",
        subscriptionStatus: "active",
        paidThroughAt,
        stripeCustomerId: null,
        stripeSubscriptionId: null,
      }),
    );
    expect(mockRecordManualPlanGrant).toHaveBeenCalledWith("pro");
  });

  it("rejects conflicting replay of the same payment reference", async () => {
    mockFindManualBillingEventByUserAndPaymentReference.mockResolvedValue({
      id: "event-1",
      telegramUserId: 123n,
      planCode: "personal",
      subscriptionStatus: "active",
      paidThroughAt: new Date("2026-06-30T00:00:00.000Z"),
      paymentReference: "wise-123",
      note: null,
      keptStripeLink: false,
    });

    const { db } = buildDb();
    await expect(
      grantManualUserPlan(db, {
        telegramUserId: 123n,
        planCode: "pro",
        subscriptionStatus: "active",
        paidThroughAt: new Date("2026-06-30T00:00:00.000Z"),
        paymentReference: "wise-123",
        note: null,
        keptStripeLink: false,
        operatorSource: "cli",
      }),
    ).resolves.toEqual({ ok: false, code: "payment_reference_conflict" });

    expect(mockFindOrCreateManualBillingEvent).not.toHaveBeenCalled();
    expect(mockUpdateUserBillingState).not.toHaveBeenCalled();
  });

  it("reconciles an idempotent replay when the stored event matches but user state drifted", async () => {
    const paidThroughAt = new Date("2026-06-30T00:00:00.000Z");
    mockFindUserByIdForUpdate.mockResolvedValue(user({ planCode: "free" }));
    mockFindManualBillingEventByUserAndPaymentReference.mockResolvedValue({
      id: "event-1",
      telegramUserId: 123n,
      planCode: "pro",
      subscriptionStatus: "active",
      paidThroughAt,
      paymentReference: "wise-123",
      note: null,
      keptStripeLink: false,
      operatorSource: "cli",
    });

    const { db } = buildDb();
    const result = await grantManualUserPlan(db, {
      telegramUserId: 123n,
      planCode: "pro",
      subscriptionStatus: "active",
      paidThroughAt,
      paymentReference: "wise-123",
      note: null,
      keptStripeLink: false,
      operatorSource: "cli",
    });

    expect(result).toMatchObject({ ok: true, idempotent: true, reconciled: true });
    expect(mockUpdateUserBillingState).toHaveBeenCalledOnce();
    expect(mockRecordManualPlanGrant).not.toHaveBeenCalled();
  });

  it("rolls back a new event when the submitted user version is stale", async () => {
    const { db } = buildDb();

    await expect(
      grantManualUserPlan(db, {
        telegramUserId: 123n,
        planCode: "pro",
        subscriptionStatus: "active",
        paidThroughAt: new Date("2026-06-30T00:00:00.000Z"),
        paymentReference: "wise-123",
        note: null,
        keptStripeLink: false,
        operatorSource: "cli",
        expectedUpdatedAt: "2026-05-18T09:59:00.000Z",
      }),
    ).resolves.toEqual({ ok: false, code: "concurrent_update" });

    expect(mockFindOrCreateManualBillingEvent).toHaveBeenCalledOnce();
    expect(mockUpdateUserBillingState).not.toHaveBeenCalled();
    expect(mockRecordManualPlanGrant).not.toHaveBeenCalled();
  });

  it("validates paid plan and payment reference invariants before writing", async () => {
    const { db } = buildDb();

    await expect(
      grantManualUserPlan(db, {
        telegramUserId: 123n,
        planCode: "pro",
        subscriptionStatus: "active",
        paidThroughAt: null,
        paymentReference: "",
        note: null,
        keptStripeLink: false,
        operatorSource: "cli",
      }),
    ).resolves.toEqual({ ok: false, code: "paid_through_required" });

    expect(mockFindOrCreateUserById).not.toHaveBeenCalled();
    expect(mockFindOrCreateManualBillingEvent).not.toHaveBeenCalled();
  });
});
