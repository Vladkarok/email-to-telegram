import { describe, expect, it } from "vitest";
import {
  getPlanDefinition,
  isPlanCode,
  NON_FREE_PLAN_CODES,
  PLAN_DEFINITIONS,
  SELF_SERVE_PLAN_CODES,
} from "../../../src/billing/plans.js";

describe("billing plans", () => {
  it("defines the free hosted limits", () => {
    expect(PLAN_DEFINITIONS.free.limits).toMatchObject({
      aliases: 3,
      users: 1,
      chats: 1,
      allowRules: 10,
      deliveredEmailsMonth: 100,
      maxMessageBytes: 5 * 1024 * 1024,
      retentionDays: 7,
      customDomains: 0,
    });
  });

  it("defines paid plan prices and higher limits", () => {
    expect(PLAN_DEFINITIONS.personal.monthlyPriceUsd).toBe(5);
    expect(PLAN_DEFINITIONS.personal.yearlyPriceUsd).toBe(48);
    expect(PLAN_DEFINITIONS.pro.monthlyPriceUsd).toBe(12);
    expect(PLAN_DEFINITIONS.team.monthlyPriceUsd).toBe(29);
    expect(PLAN_DEFINITIONS.pro.limits.maxMessageBytes).toBe(25 * 1024 * 1024);
    expect(PLAN_DEFINITIONS.team.limits.customDomains).toBe(3);
  });

  it("treats business as manually priced with high default limits", () => {
    expect(PLAN_DEFINITIONS.business.monthlyPriceUsd).toBeNull();
    expect(PLAN_DEFINITIONS.business.yearlyPriceUsd).toBeNull();
    expect(PLAN_DEFINITIONS.business.limits.deliveredEmailsMonth).toBeGreaterThan(
      PLAN_DEFINITIONS.team.limits.deliveredEmailsMonth,
    );
  });

  it("looks up and validates own plan codes", () => {
    expect(isPlanCode("pro")).toBe(true);
    expect(isPlanCode("unknown")).toBe(false);
    expect(isPlanCode("toString")).toBe(false);
    expect(isPlanCode("__proto__")).toBe(false);
    expect(getPlanDefinition("pro")).toBe(PLAN_DEFINITIONS.pro);
  });

  it("separates self-serve and manual non-free plan codes", () => {
    expect(SELF_SERVE_PLAN_CODES).toEqual(["personal", "pro", "team"]);
    expect(NON_FREE_PLAN_CODES).toEqual(["personal", "pro", "team", "business"]);
  });
});
