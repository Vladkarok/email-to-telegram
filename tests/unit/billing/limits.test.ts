import { beforeEach, describe, expect, it, vi } from "vitest";

const mockLoadConfig = vi.fn(() => ({ appMode: "self-hosted" }));
const mockFindOrganizationById = vi.fn();
const mockCountActiveAliasesByOrganization = vi.fn();
const mockCountAllowRulesByOrganization = vi.fn();

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

const { checkAliasCreateLimit, checkAllowRuleCreateLimit, getEffectivePlan } =
  await import("../../../src/billing/limits.js");

describe("billing limits", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadConfig.mockReturnValue({ appMode: "self-hosted" });
  });

  it("skips quota enforcement outside hosted mode", async () => {
    await expect(checkAliasCreateLimit({} as never, "org-1")).resolves.toEqual({ ok: true });
    await expect(checkAllowRuleCreateLimit({} as never, "org-1")).resolves.toEqual({ ok: true });
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
});
