import { beforeEach, describe, expect, it, vi } from "vitest";

const mockLoadConfig = vi.fn(() => ({ appMode: "self-hosted" }));
const mockFindOrganizationById = vi.fn();
const mockCountActiveAliasesByOrganization = vi.fn();
const mockCountAllowRulesByOrganization = vi.fn();
const mockGetOrganizationUsageMonth = vi.fn();
const mockGetOrganizationStorageUsage = vi.fn();

vi.mock("../../../src/config.js", () => ({
  loadConfig: (): unknown => mockLoadConfig(),
}));

vi.mock("../../../src/db/repos/organizations.js", () => ({
  findOrganizationById: (...args: unknown[]): unknown => mockFindOrganizationById(...args),
}));

vi.mock("../../../src/db/repos/aliases.js", () => ({
  countActiveAliasesByOrganization: (...args: unknown[]): unknown =>
    mockCountActiveAliasesByOrganization(...args),
}));

vi.mock("../../../src/db/repos/allowRules.js", () => ({
  countAllowRulesByOrganization: (...args: unknown[]): unknown =>
    mockCountAllowRulesByOrganization(...args),
}));

vi.mock("../../../src/db/repos/usage.js", () => ({
  getOrganizationUsageMonth: (...args: unknown[]): unknown =>
    mockGetOrganizationUsageMonth(...args),
  usageMonthForDate: vi.fn(() => "2026-04"),
}));

vi.mock("../../../src/db/repos/storageUsage.js", () => ({
  getOrganizationStorageUsage: (...args: unknown[]): unknown =>
    mockGetOrganizationStorageUsage(...args),
}));

const { checkAliasCreateLimit, checkAllowRuleCreateLimit, checkInboundLimit, getEffectivePlan } =
  await import("../../../src/billing/limits.js");

describe("billing limits", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadConfig.mockReturnValue({ appMode: "self-hosted" });
    mockGetOrganizationStorageUsage.mockResolvedValue(null);
  });

  it("skips quota enforcement outside hosted mode", async () => {
    await expect(checkAliasCreateLimit({} as never, "org-1")).resolves.toEqual({ ok: true });
    await expect(checkAllowRuleCreateLimit({} as never, "org-1")).resolves.toEqual({ ok: true });
    await expect(checkInboundLimit({} as never, "org-1")).resolves.toEqual({ ok: true });
    expect(mockFindOrganizationById).not.toHaveBeenCalled();
  });

  it("enforces hosted alias limits from the effective plan", async () => {
    mockLoadConfig.mockReturnValue({ appMode: "hosted" });
    mockFindOrganizationById.mockResolvedValue({
      id: "org-1",
      planCode: "free",
      subscriptionStatus: "free",
      currentPeriodEnd: null,
    });
    mockCountActiveAliasesByOrganization.mockResolvedValue(3);

    await expect(checkAliasCreateLimit({} as never, "org-1")).resolves.toEqual({
      ok: false,
      code: "alias_limit",
      limit: 3,
      used: 3,
    });
  });

  it("allows hosted alias creation when usage is below the limit", async () => {
    mockLoadConfig.mockReturnValue({ appMode: "hosted" });
    mockFindOrganizationById.mockResolvedValue({
      id: "org-1",
      planCode: "free",
      subscriptionStatus: "free",
      currentPeriodEnd: null,
    });
    mockCountActiveAliasesByOrganization.mockResolvedValue(2);

    await expect(checkAliasCreateLimit({} as never, "org-1")).resolves.toEqual({ ok: true });
  });

  it("returns subscription_inactive when the alias org row is missing", async () => {
    mockLoadConfig.mockReturnValue({ appMode: "hosted" });
    mockFindOrganizationById.mockResolvedValue(null);

    await expect(checkAliasCreateLimit({} as never, "org-1")).resolves.toEqual({
      ok: false,
      code: "subscription_inactive",
    });
  });

  it("enforces hosted allow-rule limits from the effective plan", async () => {
    mockLoadConfig.mockReturnValue({ appMode: "hosted" });
    mockFindOrganizationById.mockResolvedValue({
      id: "org-1",
      planCode: "free",
      subscriptionStatus: "free",
      currentPeriodEnd: null,
    });
    mockCountAllowRulesByOrganization.mockResolvedValue(10);

    await expect(checkAllowRuleCreateLimit({} as never, "org-1")).resolves.toEqual({
      ok: false,
      code: "allow_rule_limit",
      limit: 10,
      used: 10,
    });
  });

  it("allows hosted allow-rule creation when usage is below the limit", async () => {
    mockLoadConfig.mockReturnValue({ appMode: "hosted" });
    mockFindOrganizationById.mockResolvedValue({
      id: "org-1",
      planCode: "free",
      subscriptionStatus: "free",
      currentPeriodEnd: null,
    });
    mockCountAllowRulesByOrganization.mockResolvedValue(9);

    await expect(checkAllowRuleCreateLimit({} as never, "org-1")).resolves.toEqual({ ok: true });
  });

  it("treats missing hosted organization ids as inactive subscription state", async () => {
    mockLoadConfig.mockReturnValue({ appMode: "hosted" });

    await expect(checkAliasCreateLimit({} as never, null)).resolves.toEqual({
      ok: false,
      code: "subscription_inactive",
    });
    await expect(checkAllowRuleCreateLimit({} as never, null)).resolves.toEqual({
      ok: false,
      code: "subscription_inactive",
    });
    await expect(checkInboundLimit({} as never, null)).resolves.toEqual({
      ok: false,
      code: "subscription_inactive",
    });
    expect(mockFindOrganizationById).not.toHaveBeenCalled();
  });

  it("enforces hosted monthly inbound quota from the effective plan", async () => {
    mockLoadConfig.mockReturnValue({ appMode: "hosted" });
    mockFindOrganizationById.mockResolvedValue({
      id: "org-1",
      planCode: "free",
      subscriptionStatus: "free",
      currentPeriodEnd: null,
    });
    mockGetOrganizationUsageMonth.mockResolvedValue({
      deliveredCount: 100,
      rejectedCount: 0,
    });

    await expect(checkInboundLimit({} as never, "org-1")).resolves.toEqual({
      ok: false,
      code: "monthly_email_limit",
      limit: 100,
      used: 100,
    });
  });

  it("rejects hosted inbound mail that exceeds the plan message size", async () => {
    mockLoadConfig.mockReturnValue({ appMode: "hosted" });
    mockFindOrganizationById.mockResolvedValue({
      id: "org-1",
      planCode: "free",
      subscriptionStatus: "free",
      currentPeriodEnd: null,
    });
    mockGetOrganizationUsageMonth.mockResolvedValue({
      deliveredCount: 0,
      rejectedCount: 0,
    });

    await expect(checkInboundLimit({} as never, "org-1", 6 * 1024 * 1024)).resolves.toEqual({
      ok: false,
      code: "message_size_limit",
      limit: 5 * 1024 * 1024,
      used: 6 * 1024 * 1024,
    });
  });

  it("allows hosted inbound mail when monthly usage is below the plan limit", async () => {
    mockLoadConfig.mockReturnValue({ appMode: "hosted" });
    mockFindOrganizationById.mockResolvedValue({
      id: "org-1",
      planCode: "free",
      subscriptionStatus: "free",
      currentPeriodEnd: null,
    });
    mockGetOrganizationUsageMonth.mockResolvedValue({
      deliveredCount: 99,
      rejectedCount: 0,
    });

    await expect(checkInboundLimit({} as never, "org-1")).resolves.toEqual({ ok: true });
  });

  it("rejects hosted inbound mail when projected storage exceeds the plan limit", async () => {
    mockLoadConfig.mockReturnValue({ appMode: "hosted" });
    mockFindOrganizationById.mockResolvedValue({
      id: "org-1",
      planCode: "free",
      subscriptionStatus: "free",
      currentPeriodEnd: null,
    });
    mockGetOrganizationUsageMonth.mockResolvedValue({
      deliveredCount: 0,
      rejectedCount: 0,
    });
    mockGetOrganizationStorageUsage.mockResolvedValue({
      rawEmailBytes: 99n * 1024n * 1024n,
      attachmentBytes: 0n,
    });

    await expect(
      checkInboundLimit({} as never, "org-1", undefined, 2n * 1024n * 1024n),
    ).resolves.toEqual({
      ok: false,
      code: "storage_limit",
      limit: 100 * 1024 * 1024,
      used: 99 * 1024 * 1024,
    });
  });

  it("falls back to free limits when a paid plan is canceled", () => {
    const plan = getEffectivePlan({
      planCode: "pro",
      subscriptionStatus: "canceled",
      currentPeriodEnd: new Date(),
    });

    expect(plan.code).toBe("free");
  });

  it("keeps paid limits during recent past_due grace", () => {
    const plan = getEffectivePlan({
      planCode: "pro",
      subscriptionStatus: "past_due",
      currentPeriodEnd: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
    });

    expect(plan.code).toBe("pro");
  });

  it("falls back to free limits when past_due is outside grace", () => {
    const plan = getEffectivePlan({
      planCode: "pro",
      subscriptionStatus: "past_due",
      currentPeriodEnd: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
    });

    expect(plan.code).toBe("free");
  });

  it("keeps the business plan regardless of subscription status", () => {
    const plan = getEffectivePlan({
      planCode: "business",
      subscriptionStatus: "canceled",
      currentPeriodEnd: null,
    });

    expect(plan.code).toBe("business");
  });
});
