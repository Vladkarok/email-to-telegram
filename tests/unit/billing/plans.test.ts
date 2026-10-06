import { afterEach, describe, expect, it } from "vitest";
import {
  applyPlanLimitOverrides,
  getPlanDefinition,
  isPlanCode,
  listPlanDefinitions,
  NON_FREE_PLAN_CODES,
  PLAN_CODES,
  SELF_SERVE_PLAN_CODES,
} from "../../../src/billing/plans.js";

describe("billing plans", () => {
  afterEach(() => {
    applyPlanLimitOverrides({});
  });

  it("defines the free hosted limits", () => {
    expect(getPlanDefinition("free").limits).toMatchObject({
      aliases: 3,
      allowRules: 10,
      deliveredEmailsMonth: 200,
      egressBytesMonth: 1024 * 1024 * 1024,
      maxMessageBytes: 5 * 1024 * 1024,
      retentionDays: 7,
      customDomains: 0,
    });
  });

  it("defines paid plan prices and higher limits", () => {
    expect(getPlanDefinition("personal").monthlyPriceUsd).toBe(5);
    expect(getPlanDefinition("personal").yearlyPriceUsd).toBe(48);
    expect(getPlanDefinition("pro").monthlyPriceUsd).toBe(12);
    expect(getPlanDefinition("team").monthlyPriceUsd).toBe(29);
    expect(getPlanDefinition("personal").limits.egressBytesMonth).toBe(10 * 1024 * 1024 * 1024);
    expect(getPlanDefinition("pro").limits.maxMessageBytes).toBe(25 * 1024 * 1024);
    expect(getPlanDefinition("pro").limits.customDomains).toBe(0);
    expect(getPlanDefinition("team").limits.customDomains).toBe(3);
  });

  it("treats business as manually priced with high default limits", () => {
    expect(getPlanDefinition("business").monthlyPriceUsd).toBeNull();
    expect(getPlanDefinition("business").yearlyPriceUsd).toBeNull();
    expect(getPlanDefinition("business").limits.deliveredEmailsMonth).toBeGreaterThan(
      getPlanDefinition("team").limits.deliveredEmailsMonth,
    );
  });

  it("looks up and validates own plan codes", () => {
    expect(isPlanCode("pro")).toBe(true);
    expect(isPlanCode("unknown")).toBe(false);
    expect(isPlanCode("toString")).toBe(false);
    expect(isPlanCode("__proto__")).toBe(false);
  });

  it("separates self-serve and manual non-free plan codes", () => {
    expect(SELF_SERVE_PLAN_CODES).toEqual(["personal", "pro", "team"]);
    expect(NON_FREE_PLAN_CODES).toEqual(["personal", "pro", "team", "business"]);
  });

  it("overrides exactly the named limit of the named plan", () => {
    const defaults = PLAN_CODES.map((code) => getPlanDefinition(code));

    applyPlanLimitOverrides({ free: { deliveredEmailsMonth: 300 } });

    expect(getPlanDefinition("free").limits).toEqual({
      ...defaults[0].limits,
      deliveredEmailsMonth: 300,
    });
    expect(getPlanDefinition("free").name).toBe("Free");
    for (const [index, code] of PLAN_CODES.entries()) {
      if (code !== "free") expect(getPlanDefinition(code)).toEqual(defaults[index]);
    }
    expect(listPlanDefinitions().map((plan) => plan.limits.deliveredEmailsMonth)).toContain(300);
  });

  it("rebuilds from the defaults on every call", () => {
    applyPlanLimitOverrides({ free: { deliveredEmailsMonth: 300 } });
    applyPlanLimitOverrides({ pro: { aliases: 7 } });

    expect(getPlanDefinition("free").limits.deliveredEmailsMonth).toBe(200);
    expect(getPlanDefinition("pro").limits.aliases).toBe(7);

    applyPlanLimitOverrides({});
    expect(getPlanDefinition("pro").limits.aliases).toBe(50);
  });

  it("hands out frozen plans so a caller cannot change limits for everyone", () => {
    applyPlanLimitOverrides({ free: { retentionDays: 3 } });
    const plan = getPlanDefinition("free");
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.limits)).toBe(true);
  });
});
