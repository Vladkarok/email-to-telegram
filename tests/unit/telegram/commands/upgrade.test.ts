import { beforeEach, describe, it, expect, vi } from "vitest";
import { createMockCtx } from "../../../helpers/mockContext.js";

vi.mock("../../../../src/db/client.js", () => ({ getDb: vi.fn(() => ({})) }));

const mockLoadConfig = vi.fn(() => ({ appMode: "hosted" }));
vi.mock("../../../../src/config.js", () => ({
  loadConfig: (): unknown => mockLoadConfig(),
}));

const mockGetBillingOrganizationForUser = vi.fn();
vi.mock("../../../../src/tenant/currentOrganization.js", () => ({
  getBillingOrganizationForUser: (...args: unknown[]): unknown =>
    mockGetBillingOrganizationForUser(...args),
}));

const mockCreateCheckoutSession = vi.fn();
vi.mock("../../../../src/billing/checkout.js", () => ({
  createCheckoutSession: (...args: unknown[]): unknown => mockCreateCheckoutSession(...args),
  BillingCheckoutConflictError: class BillingCheckoutConflictError extends Error {
    constructor(message = "Organization already has a Stripe subscription") {
      super(message);
      this.name = "BillingCheckoutConflictError";
    }
  },
}));

const mockGetLogger = vi.fn(() => ({ error: vi.fn() }));
vi.mock("../../../../src/utils/logger.js", () => ({
  getLogger: (): unknown => mockGetLogger(),
}));

const { upgradeHandler, upgradeCallbackHandler, upgradePlanCallbackHandler } =
  await import("../../../../src/telegram/commands/upgrade.js");

const ORG = {
  id: "org-1",
  name: "Test",
  planCode: "free",
  subscriptionStatus: "free",
  currentPeriodEnd: null,
};

describe("/upgrade command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadConfig.mockReturnValue({ appMode: "hosted" });
    mockGetBillingOrganizationForUser.mockResolvedValue(ORG);
  });

  it("in self-hosted mode replies with billing-disabled message", async () => {
    mockLoadConfig.mockReturnValue({ appMode: "self-hosted" });
    const ctx = createMockCtx({ chatType: "private" });
    await upgradeHandler(ctx);
    const [text] = ctx.reply.mock.calls[0] as [string];
    expect(text).toMatch(/self-hosted|billing.*not enabled/i);
    expect(mockGetBillingOrganizationForUser).not.toHaveBeenCalled();
  });

  it("in hosted mode without owner/admin access replies defensively", async () => {
    mockGetBillingOrganizationForUser.mockResolvedValue(null);
    const ctx = createMockCtx({ chatType: "private" });
    await upgradeHandler(ctx);
    const [text] = ctx.reply.mock.calls[0] as [string];
    expect(text).toMatch(/owner|admin|billing/i);
  });

  it("shows plan selection keyboard with all 6 plan buttons", async () => {
    const ctx = createMockCtx({ chatType: "private" });
    await upgradeHandler(ctx);
    const [text, opts] = ctx.reply.mock.calls[0] as [
      string,
      {
        parse_mode?: string;
        reply_markup?: { inline_keyboard: Array<Array<{ callback_data?: string }>> };
      },
    ];
    expect(text).toMatch(/upgrade|plan/i);
    expect(opts.parse_mode).toBe("HTML");
    const buttons = opts.reply_markup?.inline_keyboard.flat() ?? [];
    const callbacks = buttons.map((b) => b.callback_data);
    expect(callbacks).toContain("upg:personal_monthly");
    expect(callbacks).toContain("upg:personal_yearly");
    expect(callbacks).toContain("upg:pro_monthly");
    expect(callbacks).toContain("upg:pro_yearly");
    expect(callbacks).toContain("upg:team_monthly");
    expect(callbacks).toContain("upg:team_yearly");
  });

  it("replies with error on DB failure", async () => {
    mockGetBillingOrganizationForUser.mockRejectedValue(new Error("connection refused"));
    const mockError = vi.fn();
    mockGetLogger.mockReturnValue({ error: mockError });
    const ctx = createMockCtx({ chatType: "private" });
    await upgradeHandler(ctx);
    const [text] = ctx.reply.mock.calls[0] as [string];
    expect(text).toMatch(/unable|try again/i);
    expect(mockError).toHaveBeenCalled();
  });
});

describe("upgradeCallbackHandler (bill:upgrade)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadConfig.mockReturnValue({ appMode: "hosted" });
    mockGetBillingOrganizationForUser.mockResolvedValue(ORG);
  });

  it("answers callback and sends plan selection keyboard", async () => {
    const ctx = createMockCtx({ chatType: "private" });
    await upgradeCallbackHandler(ctx);
    expect(ctx.answerCallbackQuery).toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalled();
    const [, opts] = ctx.reply.mock.calls[0] as [
      string,
      { reply_markup?: { inline_keyboard: Array<Array<{ callback_data?: string }>> } },
    ];
    const callbacks = opts.reply_markup?.inline_keyboard.flat().map((b) => b.callback_data) ?? [];
    expect(callbacks).toContain("upg:personal_monthly");
  });

  it("answers with show_alert when self-hosted", async () => {
    mockLoadConfig.mockReturnValue({ appMode: "self-hosted" });
    const ctx = createMockCtx({ chatType: "private" });
    await upgradeCallbackHandler(ctx);
    const call = ctx.answerCallbackQuery.mock.calls[0][0] as { show_alert: boolean };
    expect(call.show_alert).toBe(true);
    expect(ctx.reply).not.toHaveBeenCalled();
  });
});

describe("upgradePlanCallbackHandler (upg:{priceKey})", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadConfig.mockReturnValue({ appMode: "hosted" });
    mockGetBillingOrganizationForUser.mockResolvedValue(ORG);
    mockCreateCheckoutSession.mockResolvedValue("https://checkout.stripe.com/pay/cs_test_abc");
  });

  it("creates checkout session and replies with URL button for valid price key", async () => {
    const ctx = createMockCtx({ chatType: "private" });
    (ctx as unknown as { match: string[] }).match = ["upg:personal_monthly", "personal_monthly"];
    await upgradePlanCallbackHandler(ctx);
    expect(mockCreateCheckoutSession).toHaveBeenCalledWith({}, "org-1", "personal_monthly");
    expect(ctx.answerCallbackQuery).toHaveBeenCalled();
    const [text, opts] = ctx.reply.mock.calls[0] as [
      string,
      { reply_markup?: { inline_keyboard: Array<Array<{ url?: string }>> } },
    ];
    expect(text).toMatch(/personal.*monthly/i);
    const buttons = opts.reply_markup?.inline_keyboard.flat() ?? [];
    expect(buttons.some((b) => b.url === "https://checkout.stripe.com/pay/cs_test_abc")).toBe(true);
  });

  it("answers with show_alert in self-hosted mode without calling checkout", async () => {
    mockLoadConfig.mockReturnValue({ appMode: "self-hosted" });
    const ctx = createMockCtx({ chatType: "private" });
    (ctx as unknown as { match: string[] }).match = ["upg:personal_monthly", "personal_monthly"];
    await upgradePlanCallbackHandler(ctx);
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
    const call = ctx.answerCallbackQuery.mock.calls[0][0] as { show_alert: boolean };
    expect(call.show_alert).toBe(true);
  });

  it("answers with show_alert for invalid price key", async () => {
    const ctx = createMockCtx({ chatType: "private" });
    (ctx as unknown as { match: string[] }).match = ["upg:invalid_plan", "invalid_plan"];
    await upgradePlanCallbackHandler(ctx);
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
    const call = ctx.answerCallbackQuery.mock.calls[0][0] as { show_alert: boolean; text: string };
    expect(call.show_alert).toBe(true);
    expect(call.text).toMatch(/invalid/i);
  });

  it("answers with conflict message when org already has an active subscription", async () => {
    const { BillingCheckoutConflictError } = await import("../../../../src/billing/checkout.js");
    mockCreateCheckoutSession.mockRejectedValue(new BillingCheckoutConflictError());
    const ctx = createMockCtx({ chatType: "private" });
    (ctx as unknown as { match: string[] }).match = ["upg:pro_monthly", "pro_monthly"];
    await upgradePlanCallbackHandler(ctx);
    const call = ctx.answerCallbackQuery.mock.calls[0][0] as { show_alert: boolean; text: string };
    expect(call.show_alert).toBe(true);
    expect(call.text).toMatch(/already.*subscription|portal/i);
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it("answers with generic error on unexpected Stripe failure", async () => {
    mockCreateCheckoutSession.mockRejectedValue(new Error("Stripe API error"));
    const mockError = vi.fn();
    mockGetLogger.mockReturnValue({ error: mockError });
    const ctx = createMockCtx({ chatType: "private" });
    (ctx as unknown as { match: string[] }).match = ["upg:pro_yearly", "pro_yearly"];
    await upgradePlanCallbackHandler(ctx);
    const call = ctx.answerCallbackQuery.mock.calls[0][0] as { show_alert: boolean; text: string };
    expect(call.show_alert).toBe(true);
    expect(call.text).toMatch(/unable|try again/i);
    expect(mockError).toHaveBeenCalled();
  });

  it("answers with no-org message when organization not found", async () => {
    mockGetBillingOrganizationForUser.mockResolvedValue(null);
    const ctx = createMockCtx({ chatType: "private" });
    (ctx as unknown as { match: string[] }).match = ["upg:team_monthly", "team_monthly"];
    await upgradePlanCallbackHandler(ctx);
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
    const call = ctx.answerCallbackQuery.mock.calls[0][0] as { show_alert: boolean; text: string };
    expect(call.show_alert).toBe(true);
    expect(call.text).toMatch(/owner|admin|billing/i);
  });
});
