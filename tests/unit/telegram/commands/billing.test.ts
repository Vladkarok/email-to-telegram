import { beforeEach, describe, it, expect, vi } from "vitest";
import { createMockCtx } from "../../../helpers/mockContext.js";

vi.mock("../../../../src/db/client.js", () => ({ getDb: vi.fn(() => ({})) }));

const mockLoadConfig = vi.fn(() => ({ appMode: "hosted", billingProvider: "stripe" }));
vi.mock("../../../../src/config.js", () => ({
  loadConfig: (): unknown => mockLoadConfig(),
}));

const mockFindUserById = vi.fn();
vi.mock("../../../../src/db/repos/users.js", () => ({
  findUserById: (...args: unknown[]): unknown => mockFindUserById(...args),
}));

const mockGetUserUsageMonth = vi.fn();
const mockUsageMonthForDate = vi.fn(() => "2026-04");
vi.mock("../../../../src/db/repos/usage.js", () => ({
  getUserUsageMonth: (...args: unknown[]): unknown => mockGetUserUsageMonth(...args),
  usageMonthForDate: (...args: unknown[]): unknown => mockUsageMonthForDate(...args),
}));

const mockGetUserStorageUsage = vi.fn();
vi.mock("../../../../src/db/repos/storageUsage.js", () => ({
  getUserStorageUsage: (...args: unknown[]): unknown => mockGetUserStorageUsage(...args),
}));

const mockCountActiveAliasesByUser = vi.fn();
vi.mock("../../../../src/db/repos/aliases.js", () => ({
  countActiveAliasesByUser: (...args: unknown[]): unknown => mockCountActiveAliasesByUser(...args),
}));

const mockGetLogger = vi.fn(() => ({ error: vi.fn() }));
vi.mock("../../../../src/utils/logger.js", () => ({
  getLogger: (): unknown => mockGetLogger(),
}));

const { billingHandler } = await import("../../../../src/telegram/commands/billing.js");

describe("/billing command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadConfig.mockReturnValue({ appMode: "hosted", billingProvider: "stripe" });
    mockFindUserById.mockResolvedValue(null);
    mockUsageMonthForDate.mockReturnValue("2026-04");
    mockGetUserUsageMonth.mockResolvedValue({
      organizationId: "org-1",
      month: "2026-04",
      deliveredCount: 0,
      rejectedCount: 0,
      egressBytes: 0n,
    });
    mockGetUserStorageUsage.mockResolvedValue({
      organizationId: "org-1",
      rawEmailBytes: 0n,
      attachmentBytes: 0n,
    });
    mockCountActiveAliasesByUser.mockResolvedValue(0);
  });

  it("in self-hosted mode replies with billing-disabled message", async () => {
    mockLoadConfig.mockReturnValue({ appMode: "self-hosted", billingProvider: "none" });
    const ctx = createMockCtx({ chatType: "private" });

    await billingHandler(ctx);

    const [text] = ctx.reply.mock.calls[0] as [string, unknown];
    expect(text).toMatch(/self-hosted|billing.*not enabled/i);
  });

  it("in hosted mode with no organization replies defensively", async () => {
    mockFindUserById.mockResolvedValue(null);
    const ctx = createMockCtx({ chatType: "private" });

    await billingHandler(ctx);

    const [text] = ctx.reply.mock.calls[0] as [string, unknown];
    expect(text).toMatch(/no.*account|organization.*not found/i);
  });

  it("renders status text and inline keyboard with Upgrade and Manage Billing buttons", async () => {
    mockFindUserById.mockResolvedValue({
      id: "org-1",
      username: "acme",
      planCode: "free",
      subscriptionStatus: "free",
      currentPeriodEnd: null,
    });
    mockFindUserById.mockResolvedValue({
      id: "org-1",
      username: "acme",
      planCode: "free",
      subscriptionStatus: "free",
      currentPeriodEnd: null,
    });
    const ctx = createMockCtx({ chatType: "private" });

    await billingHandler(ctx);

    const [text, opts] = ctx.reply.mock.calls[0] as [
      string,
      { parse_mode?: string; reply_markup?: unknown },
    ];
    expect(text).toContain("@acme");
    expect(opts.parse_mode).toBe("HTML");
    expect(opts.reply_markup).toBeDefined();
    const markup = opts.reply_markup as { inline_keyboard: unknown[][] };
    const flatButtons = markup.inline_keyboard.flat() as Array<{
      text: string;
      callback_data?: string;
    }>;
    const labels = flatButtons.map((b) => b.text);
    expect(labels.some((l) => /upgrade/i.test(l))).toBe(true);
    expect(labels.some((l) => /manage|portal|billing/i.test(l))).toBe(true);
    const callbacks = flatButtons.map((b) => b.callback_data);
    expect(callbacks).toContain("bill:upgrade");
    expect(callbacks).toContain("bill:portal");
  });

  it("omits billing action buttons when self-serve billing is disabled", async () => {
    mockLoadConfig.mockReturnValue({ appMode: "hosted", billingProvider: "none" });
    mockFindUserById.mockResolvedValue({
      id: "org-1",
      username: "acme",
      planCode: "free",
      subscriptionStatus: "free",
      currentPeriodEnd: null,
    });
    mockFindUserById.mockResolvedValue({
      id: "org-1",
      username: "acme",
      planCode: "free",
      subscriptionStatus: "free",
      currentPeriodEnd: null,
    });

    const ctx = createMockCtx({ chatType: "private" });
    await billingHandler(ctx);

    const [text, opts] = ctx.reply.mock.calls[0] as [
      string,
      { parse_mode?: string; reply_markup?: unknown },
    ];
    expect(text).toContain("@acme");
    expect(text).toMatch(/self-serve payments|manual|support/i);
    expect(opts.parse_mode).toBe("HTML");
    expect(opts.reply_markup).toBeUndefined();
  });

  it("omits billing action buttons for manual paid organizations even when Stripe is enabled", async () => {
    mockFindUserById.mockResolvedValue({
      id: "org-1",
      username: "acme",
      planCode: "pro",
      subscriptionStatus: "active",
      stripeCustomerId: null,
      currentPeriodEnd: null,
    });
    mockFindUserById.mockResolvedValue({
      id: "org-1",
      username: "acme",
      planCode: "pro",
      subscriptionStatus: "active",
      stripeCustomerId: null,
      currentPeriodEnd: null,
    });

    const ctx = createMockCtx({ chatType: "private" });
    await billingHandler(ctx);

    const [text, opts] = ctx.reply.mock.calls[0] as [
      string,
      { parse_mode?: string; reply_markup?: unknown },
    ];
    expect(text).toContain("@acme");
    expect(text).toMatch(/self-serve payments|manual|support/i);
    expect(opts.parse_mode).toBe("HTML");
    expect(opts.reply_markup).toBeUndefined();
  });

  it("shows monthly accepted count and current alias usage", async () => {
    mockFindUserById.mockResolvedValue({
      id: "org-1",
      username: "acme",
      planCode: "free",
      subscriptionStatus: "free",
      currentPeriodEnd: null,
    });
    mockGetUserUsageMonth.mockResolvedValue({
      organizationId: "org-1",
      month: "2026-04",
      deliveredCount: 25,
      rejectedCount: 1,
      egressBytes: 100n * 1024n * 1024n,
    });
    mockGetUserStorageUsage.mockResolvedValue({
      organizationId: "org-1",
      rawEmailBytes: 10n * 1024n * 1024n,
      attachmentBytes: 5n * 1024n * 1024n,
    });
    mockCountActiveAliasesByUser.mockResolvedValue(2);

    const ctx = createMockCtx({ chatType: "private" });
    await billingHandler(ctx);

    const [text] = ctx.reply.mock.calls[0] as [string, unknown];
    const s = String(text);
    expect(s).toMatch(/25/);
    expect(s).toMatch(/2 \/ 3/);
    expect(s).toMatch(/MB/);
  });

  it("replies with a friendly error when a DB query throws", async () => {
    mockFindUserById.mockRejectedValue(new Error("connection refused"));
    const mockError = vi.fn();
    mockGetLogger.mockReturnValue({ error: mockError });

    const ctx = createMockCtx({ chatType: "private" });
    await billingHandler(ctx);

    const [text] = ctx.reply.mock.calls[0] as [string, unknown];
    expect(text).toMatch(/temporarily unavailable/i);
    expect(mockError).toHaveBeenCalled();
  });

  it("treats missing usage and storage rows as zero", async () => {
    mockFindUserById.mockResolvedValue({
      id: "org-1",
      username: "acme",
      planCode: "free",
      subscriptionStatus: "free",
      currentPeriodEnd: null,
    });
    mockGetUserUsageMonth.mockResolvedValue(null);
    mockGetUserStorageUsage.mockResolvedValue(null);

    const ctx = createMockCtx({ chatType: "private" });
    await billingHandler(ctx);

    expect(ctx.reply).toHaveBeenCalledOnce();
    const [text] = ctx.reply.mock.calls[0] as [string, unknown];
    expect(String(text)).toContain("@acme");
  });
});
