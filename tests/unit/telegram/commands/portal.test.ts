import { beforeEach, describe, it, expect, vi } from "vitest";
import { createMockCtx } from "../../../helpers/mockContext.js";

vi.mock("../../../../src/db/client.js", () => ({ getDb: vi.fn(() => ({})) }));

const mockLoadConfig = vi.fn(() => ({ appMode: "hosted", billingProvider: "stripe" }));
vi.mock("../../../../src/config.js", () => ({
  loadConfig: (): unknown => mockLoadConfig(),
}));

const mockGetBillingOrganizationForUser = vi.fn();
vi.mock("../../../../src/tenant/currentOrganization.js", () => ({
  getBillingOrganizationForUser: (...args: unknown[]): unknown =>
    mockGetBillingOrganizationForUser(...args),
}));

const mockCreateCustomerPortalSession = vi.fn();
vi.mock("../../../../src/billing/customerPortal.js", () => ({
  createCustomerPortalSession: (...args: unknown[]): unknown =>
    mockCreateCustomerPortalSession(...args),
}));

// portal.ts imports upgrade.ts (for the plan keyboard); stub checkout to avoid Stripe SDK init
vi.mock("../../../../src/billing/checkout.js", () => ({
  createCheckoutSession: vi.fn(),
  BillingCheckoutConflictError: class extends Error {},
}));

const mockGetLogger = vi.fn(() => ({ error: vi.fn() }));
vi.mock("../../../../src/utils/logger.js", () => ({
  getLogger: (): unknown => mockGetLogger(),
}));

const { portalHandler, portalCallbackHandler } =
  await import("../../../../src/telegram/commands/portal.js");

const ORG = {
  id: "org-1",
  name: "Test",
  planCode: "pro",
  subscriptionStatus: "active",
  stripeCustomerId: "cus_123",
  currentPeriodEnd: new Date("2030-01-01"),
};

describe("/portal command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadConfig.mockReturnValue({ appMode: "hosted", billingProvider: "stripe" });
    mockGetBillingOrganizationForUser.mockResolvedValue(ORG);
    mockCreateCustomerPortalSession.mockResolvedValue("https://billing.stripe.com/session_abc");
  });

  it("in self-hosted mode replies with billing-disabled message", async () => {
    mockLoadConfig.mockReturnValue({ appMode: "self-hosted" });
    const ctx = createMockCtx({ chatType: "private" });
    await portalHandler(ctx);
    const [text] = ctx.reply.mock.calls[0] as [string];
    expect(text).toMatch(/self-hosted|billing.*not enabled/i);
    expect(mockGetBillingOrganizationForUser).not.toHaveBeenCalled();
  });

  it("in hosted mode without owner/admin access replies defensively", async () => {
    mockGetBillingOrganizationForUser.mockResolvedValue(null);
    const ctx = createMockCtx({ chatType: "private" });
    await portalHandler(ctx);
    const [text] = ctx.reply.mock.calls[0] as [string];
    expect(text).toMatch(/owner|admin|billing/i);
  });

  it("when no Stripe customer yet, shows upgrade prompt", async () => {
    mockGetBillingOrganizationForUser.mockResolvedValue({
      ...ORG,
      planCode: "free",
      stripeCustomerId: null,
    });
    mockCreateCustomerPortalSession.mockResolvedValue(null);
    const ctx = createMockCtx({ chatType: "private" });
    await portalHandler(ctx);
    const [text] = ctx.reply.mock.calls[0] as [string];
    expect(text).toMatch(/upgrade|billing account|no.*subscription/i);
  });

  it("shows manual billing support message when paid org has no Stripe customer", async () => {
    mockGetBillingOrganizationForUser.mockResolvedValue({ ...ORG, stripeCustomerId: null });
    const ctx = createMockCtx({ chatType: "private" });
    await portalHandler(ctx);
    const [text] = ctx.reply.mock.calls[0] as [string];
    expect(text).toMatch(/self-serve payments|manual|support/i);
    expect(mockCreateCustomerPortalSession).not.toHaveBeenCalled();
  });

  it("shows manual billing support message when billing provider is disabled", async () => {
    mockLoadConfig.mockReturnValue({ appMode: "hosted", billingProvider: "none" });
    const ctx = createMockCtx({ chatType: "private" });
    await portalHandler(ctx);
    const [text] = ctx.reply.mock.calls[0] as [string];
    expect(text).toMatch(/self-serve payments|manual|support/i);
    expect(mockCreateCustomerPortalSession).not.toHaveBeenCalled();
  });

  it("when Stripe customer exists, replies with portal URL button", async () => {
    const ctx = createMockCtx({ chatType: "private" });
    await portalHandler(ctx);
    const [text, opts] = ctx.reply.mock.calls[0] as [
      string,
      { parse_mode?: string; reply_markup?: { inline_keyboard: Array<Array<{ url?: string }>> } },
    ];
    expect(text).toMatch(/billing portal/i);
    expect(opts.parse_mode).toBe("HTML");
    const buttons = opts.reply_markup?.inline_keyboard.flat() ?? [];
    expect(buttons.some((b) => b.url === "https://billing.stripe.com/session_abc")).toBe(true);
  });

  it("replies with error on DB failure", async () => {
    mockGetBillingOrganizationForUser.mockRejectedValue(new Error("db error"));
    const mockError = vi.fn();
    mockGetLogger.mockReturnValue({ error: mockError });
    const ctx = createMockCtx({ chatType: "private" });
    await portalHandler(ctx);
    const [text] = ctx.reply.mock.calls[0] as [string];
    expect(text).toMatch(/unable|try again/i);
    expect(mockError).toHaveBeenCalled();
  });
});

describe("portalCallbackHandler (bill:portal)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadConfig.mockReturnValue({ appMode: "hosted", billingProvider: "stripe" });
    mockGetBillingOrganizationForUser.mockResolvedValue(ORG);
    mockCreateCustomerPortalSession.mockResolvedValue("https://billing.stripe.com/session_abc");
  });

  it("answers callback and sends portal URL button when customer exists", async () => {
    const ctx = createMockCtx({ chatType: "private" });
    await portalCallbackHandler(ctx);
    expect(ctx.answerCallbackQuery).toHaveBeenCalled();
    const [, opts] = ctx.reply.mock.calls[0] as [
      string,
      { reply_markup?: { inline_keyboard: Array<Array<{ url?: string }>> } },
    ];
    const buttons = opts.reply_markup?.inline_keyboard.flat() ?? [];
    expect(buttons.some((b) => b.url === "https://billing.stripe.com/session_abc")).toBe(true);
  });

  it("answers callback and shows upgrade prompt when no customer", async () => {
    mockGetBillingOrganizationForUser.mockResolvedValue({
      ...ORG,
      planCode: "free",
      stripeCustomerId: null,
    });
    mockCreateCustomerPortalSession.mockResolvedValue(null);
    const ctx = createMockCtx({ chatType: "private" });
    await portalCallbackHandler(ctx);
    expect(ctx.answerCallbackQuery).toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalled();
    const [text] = ctx.reply.mock.calls[0] as [string];
    expect(text).toMatch(/upgrade|plan|billing account/i);
  });

  it("answers callback and shows manual billing support message for manual paid orgs", async () => {
    mockGetBillingOrganizationForUser.mockResolvedValue({ ...ORG, stripeCustomerId: null });
    const ctx = createMockCtx({ chatType: "private" });
    await portalCallbackHandler(ctx);
    expect(ctx.answerCallbackQuery).toHaveBeenCalled();
    const [text] = ctx.reply.mock.calls[0] as [string];
    expect(text).toMatch(/self-serve payments|manual|support/i);
    expect(mockCreateCustomerPortalSession).not.toHaveBeenCalled();
  });

  it("answers with show_alert on error", async () => {
    mockGetBillingOrganizationForUser.mockRejectedValue(new Error("error"));
    const mockError = vi.fn();
    mockGetLogger.mockReturnValue({ error: mockError });
    const ctx = createMockCtx({ chatType: "private" });
    await portalCallbackHandler(ctx);
    const call = ctx.answerCallbackQuery.mock.calls[0][0] as { show_alert: boolean };
    expect(call.show_alert).toBe(true);
    expect(mockError).toHaveBeenCalled();
  });
});
