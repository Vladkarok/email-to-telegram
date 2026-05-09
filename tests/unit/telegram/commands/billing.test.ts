import { beforeEach, describe, it, expect, vi } from "vitest";
import { createMockCtx } from "../../../helpers/mockContext.js";

vi.mock("../../../../src/db/client.js", () => ({ getDb: vi.fn(() => ({})) }));

const mockLoadConfig = vi.fn(() => ({ appMode: "hosted", billingProvider: "stripe" }));
vi.mock("../../../../src/config.js", () => ({
  loadConfig: (): unknown => mockLoadConfig(),
}));

const mockGetPrimaryOrganizationForUser = vi.fn();
const mockGetBillingOrganizationForUser = vi.fn();
vi.mock("../../../../src/tenant/currentOrganization.js", () => ({
  getBillingOrganizationForUser: (...args: unknown[]): unknown =>
    mockGetBillingOrganizationForUser(...args),
  getPrimaryOrganizationForUser: (...args: unknown[]): unknown =>
    mockGetPrimaryOrganizationForUser(...args),
}));

const mockGetOrganizationUsageMonth = vi.fn();
const mockUsageMonthForDate = vi.fn(() => "2026-04");
vi.mock("../../../../src/db/repos/usage.js", () => ({
  getOrganizationUsageMonth: (...args: unknown[]): unknown =>
    mockGetOrganizationUsageMonth(...args),
  usageMonthForDate: (...args: unknown[]): unknown => mockUsageMonthForDate(...args),
}));

const mockGetOrganizationStorageUsage = vi.fn();
vi.mock("../../../../src/db/repos/storageUsage.js", () => ({
  getOrganizationStorageUsage: (...args: unknown[]): unknown =>
    mockGetOrganizationStorageUsage(...args),
}));

const mockCountActiveAliasesByOrganization = vi.fn();
vi.mock("../../../../src/db/repos/aliases.js", () => ({
  countActiveAliasesByOrganization: (...args: unknown[]): unknown =>
    mockCountActiveAliasesByOrganization(...args),
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
    mockGetBillingOrganizationForUser.mockResolvedValue(null);
    mockUsageMonthForDate.mockReturnValue("2026-04");
    mockGetOrganizationUsageMonth.mockResolvedValue({
      organizationId: "org-1",
      month: "2026-04",
      deliveredCount: 0,
      rejectedCount: 0,
      egressBytes: 0n,
    });
    mockGetOrganizationStorageUsage.mockResolvedValue({
      organizationId: "org-1",
      rawEmailBytes: 0n,
      attachmentBytes: 0n,
    });
    mockCountActiveAliasesByOrganization.mockResolvedValue(0);
  });

  it("in self-hosted mode replies with billing-disabled message", async () => {
    mockLoadConfig.mockReturnValue({ appMode: "self-hosted", billingProvider: "none" });
    const ctx = createMockCtx({ chatType: "private" });

    await billingHandler(ctx);

    const [text] = ctx.reply.mock.calls[0] as [string, unknown];
    expect(text).toMatch(/self-hosted|billing.*not enabled/i);
    expect(mockGetPrimaryOrganizationForUser).not.toHaveBeenCalled();
  });

  it("in hosted mode with no organization replies defensively", async () => {
    mockGetPrimaryOrganizationForUser.mockResolvedValue(null);
    const ctx = createMockCtx({ chatType: "private" });

    await billingHandler(ctx);

    const [text] = ctx.reply.mock.calls[0] as [string, unknown];
    expect(text).toMatch(/no.*workspace|organization.*not found/i);
  });

  it("renders status text and inline keyboard with Upgrade and Manage Billing buttons", async () => {
    mockGetPrimaryOrganizationForUser.mockResolvedValue({
      id: "org-1",
      name: "Acme Co",
      planCode: "free",
      subscriptionStatus: "free",
      currentPeriodEnd: null,
    });
    mockGetBillingOrganizationForUser.mockResolvedValue({
      id: "org-1",
      name: "Acme Co",
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
    expect(text).toContain("Acme Co");
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

  it("omits billing action buttons for non-admin organization members", async () => {
    mockGetPrimaryOrganizationForUser.mockResolvedValue({
      id: "org-1",
      name: "Acme Co",
      planCode: "free",
      subscriptionStatus: "free",
      currentPeriodEnd: null,
    });
    mockGetBillingOrganizationForUser.mockResolvedValue(null);

    const ctx = createMockCtx({ chatType: "private" });
    await billingHandler(ctx);

    const [text, opts] = ctx.reply.mock.calls[0] as [
      string,
      { parse_mode?: string; reply_markup?: unknown },
    ];
    expect(text).toContain("Acme Co");
    expect(opts.parse_mode).toBe("HTML");
    expect(opts.reply_markup).toBeUndefined();
  });

  it("omits billing action buttons when self-serve billing is disabled", async () => {
    mockLoadConfig.mockReturnValue({ appMode: "hosted", billingProvider: "none" });
    mockGetPrimaryOrganizationForUser.mockResolvedValue({
      id: "org-1",
      name: "Acme Co",
      planCode: "free",
      subscriptionStatus: "free",
      currentPeriodEnd: null,
    });
    mockGetBillingOrganizationForUser.mockResolvedValue({
      id: "org-1",
      name: "Acme Co",
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
    expect(text).toContain("Acme Co");
    expect(opts.parse_mode).toBe("HTML");
    expect(opts.reply_markup).toBeUndefined();
  });

  it("shows monthly accepted count and current alias usage", async () => {
    mockGetPrimaryOrganizationForUser.mockResolvedValue({
      id: "org-1",
      name: "Acme Co",
      planCode: "free",
      subscriptionStatus: "free",
      currentPeriodEnd: null,
    });
    mockGetOrganizationUsageMonth.mockResolvedValue({
      organizationId: "org-1",
      month: "2026-04",
      deliveredCount: 25,
      rejectedCount: 1,
      egressBytes: 100n * 1024n * 1024n,
    });
    mockGetOrganizationStorageUsage.mockResolvedValue({
      organizationId: "org-1",
      rawEmailBytes: 10n * 1024n * 1024n,
      attachmentBytes: 5n * 1024n * 1024n,
    });
    mockCountActiveAliasesByOrganization.mockResolvedValue(2);

    const ctx = createMockCtx({ chatType: "private" });
    await billingHandler(ctx);

    const [text] = ctx.reply.mock.calls[0] as [string, unknown];
    const s = String(text);
    expect(s).toMatch(/25/);
    expect(s).toMatch(/2 \/ 3/);
    expect(s).toMatch(/MB/);
  });

  it("replies with a friendly error when a DB query throws", async () => {
    mockGetPrimaryOrganizationForUser.mockRejectedValue(new Error("connection refused"));
    const mockError = vi.fn();
    mockGetLogger.mockReturnValue({ error: mockError });

    const ctx = createMockCtx({ chatType: "private" });
    await billingHandler(ctx);

    const [text] = ctx.reply.mock.calls[0] as [string, unknown];
    expect(text).toMatch(/temporarily unavailable/i);
    expect(mockError).toHaveBeenCalled();
  });

  it("treats missing usage and storage rows as zero", async () => {
    mockGetPrimaryOrganizationForUser.mockResolvedValue({
      id: "org-1",
      name: "Acme Co",
      planCode: "free",
      subscriptionStatus: "free",
      currentPeriodEnd: null,
    });
    mockGetOrganizationUsageMonth.mockResolvedValue(null);
    mockGetOrganizationStorageUsage.mockResolvedValue(null);

    const ctx = createMockCtx({ chatType: "private" });
    await billingHandler(ctx);

    expect(ctx.reply).toHaveBeenCalledOnce();
    const [text] = ctx.reply.mock.calls[0] as [string, unknown];
    expect(String(text)).toContain("Acme Co");
  });
});
