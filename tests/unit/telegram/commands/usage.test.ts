import { beforeEach, describe, it, expect, vi } from "vitest";
import { createMockCtx } from "../../../helpers/mockContext.js";

vi.mock("../../../../src/db/client.js", () => ({ getDb: vi.fn(() => ({})) }));

const mockLoadConfig = vi.fn(() => ({ appMode: "hosted" }));
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

const mockCountAllowRulesByUser = vi.fn();
vi.mock("../../../../src/db/repos/allowRules.js", () => ({
  countAllowRulesByUser: (...args: unknown[]): unknown => mockCountAllowRulesByUser(...args),
}));

const mockCountDeliveryLogsByUserInMonth = vi.fn();
vi.mock("../../../../src/db/repos/deliveryLogs.js", () => ({
  countDeliveryLogsByUserInMonth: (...args: unknown[]): unknown =>
    mockCountDeliveryLogsByUserInMonth(...args),
}));

const mockGetLogger = vi.fn(() => ({ error: vi.fn() }));
vi.mock("../../../../src/utils/logger.js", () => ({
  getLogger: (): unknown => mockGetLogger(),
}));

const { usageHandler } = await import("../../../../src/telegram/commands/usage.js");

describe("/usage command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadConfig.mockReturnValue({ appMode: "hosted" });
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
    mockCountAllowRulesByUser.mockResolvedValue(0);
    mockCountDeliveryLogsByUserInMonth.mockResolvedValue(0);
  });

  it("in self-hosted mode replies with billing-disabled message", async () => {
    mockLoadConfig.mockReturnValue({ appMode: "self-hosted" });
    const ctx = createMockCtx({ chatType: "private" });

    await usageHandler(ctx);

    const [text] = ctx.reply.mock.calls[0] as [string, unknown];
    expect(text).toMatch(/self-hosted|billing.*not enabled/i);
  });

  it("in hosted mode with no organization replies defensively", async () => {
    mockFindUserById.mockResolvedValue(null);
    const ctx = createMockCtx({ chatType: "private" });

    await usageHandler(ctx);

    const [text] = ctx.reply.mock.calls[0] as [string, unknown];
    expect(text).toMatch(/no.*account|organization.*not found/i);
  });

  it("renders accepted, rejected, telegram delivered, telegram failed, pending counts", async () => {
    mockFindUserById.mockResolvedValue({
      id: "org-1",
      name: "Test",
      planCode: "free",
      subscriptionStatus: "free",
      currentPeriodEnd: null,
    });
    mockGetUserUsageMonth.mockResolvedValue({
      organizationId: "org-1",
      month: "2026-04",
      deliveredCount: 12,
      rejectedCount: 3,
      egressBytes: 0n,
    });
    mockCountDeliveryLogsByUserInMonth.mockImplementation(
      (_db: unknown, _orgId: string, _month: string, statuses: readonly string[]) => {
        if (statuses.includes("delivered")) return Promise.resolve(9);
        if (statuses.includes("failed")) return Promise.resolve(1);
        if (statuses.includes("retrying")) return Promise.resolve(2);
        return Promise.resolve(0);
      },
    );

    const ctx = createMockCtx({ chatType: "private" });
    await usageHandler(ctx);

    const [text] = ctx.reply.mock.calls[0] as [string, unknown];
    const s = String(text);
    expect(s).toMatch(/Accepted[^\n]*12/);
    expect(s).toMatch(/Rejected[^\n]*3/);
    expect(s).toMatch(/Delivered to Telegram[^\n]*9/);
    expect(s).toMatch(/Telegram delivery failures[^\n]*1/);
    expect(s).toMatch(/Pending[^\n]*2/i);
  });

  it("replies with a friendly error when a DB query throws", async () => {
    mockFindUserById.mockRejectedValue(new Error("connection refused"));
    const mockError = vi.fn();
    mockGetLogger.mockReturnValue({ error: mockError });

    const ctx = createMockCtx({ chatType: "private" });
    await usageHandler(ctx);

    const [text] = ctx.reply.mock.calls[0] as [string, unknown];
    expect(text).toMatch(/temporarily unavailable/i);
    expect(mockError).toHaveBeenCalled();
  });

  it("renders egress, storage, aliases and allow-rule quotas", async () => {
    mockFindUserById.mockResolvedValue({
      id: "org-1",
      name: "Test",
      planCode: "free",
      subscriptionStatus: "free",
      currentPeriodEnd: null,
    });
    mockGetUserUsageMonth.mockResolvedValue({
      organizationId: "org-1",
      month: "2026-04",
      deliveredCount: 0,
      rejectedCount: 0,
      egressBytes: 100n * 1024n * 1024n,
    });
    mockGetUserStorageUsage.mockResolvedValue({
      organizationId: "org-1",
      rawEmailBytes: 30n * 1024n * 1024n,
      attachmentBytes: 20n * 1024n * 1024n,
    });
    mockCountActiveAliasesByUser.mockResolvedValue(2);
    mockCountAllowRulesByUser.mockResolvedValue(4);

    const ctx = createMockCtx({ chatType: "private" });
    await usageHandler(ctx);

    const [text] = ctx.reply.mock.calls[0] as [string, unknown];
    const s = String(text);
    expect(s).toMatch(/Egress/);
    expect(s).toMatch(/Storage/);
    expect(s).toMatch(/MB/);
    expect(s).toMatch(/Aliases[^\n]*2 \/ 3/);
    expect(s).toMatch(/Allow rules[^\n]*4 \/ 10/);
  });

  it("treats missing usage row as zero counts", async () => {
    mockFindUserById.mockResolvedValue({
      id: "org-1",
      name: "Test",
      planCode: "free",
      subscriptionStatus: "free",
      currentPeriodEnd: null,
    });
    mockGetUserUsageMonth.mockResolvedValue(null);
    mockGetUserStorageUsage.mockResolvedValue(null);

    const ctx = createMockCtx({ chatType: "private" });
    await usageHandler(ctx);

    const [text] = ctx.reply.mock.calls[0] as [string, unknown];
    const s = String(text);
    expect(s).toMatch(/Accepted[^\n]*0/);
    expect(s).toMatch(/Rejected[^\n]*0/);
  });

  it("uses HTML parse mode", async () => {
    mockFindUserById.mockResolvedValue({
      id: "org-1",
      name: "Test",
      planCode: "free",
      subscriptionStatus: "free",
      currentPeriodEnd: null,
    });

    const ctx = createMockCtx({ chatType: "private" });
    await usageHandler(ctx);

    const [, opts] = ctx.reply.mock.calls[0] as [string, { parse_mode?: string }];
    expect(opts.parse_mode).toBe("HTML");
  });
});
