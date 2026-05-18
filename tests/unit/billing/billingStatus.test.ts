import { describe, it, expect } from "vitest";
import { buildBillingStatusText } from "../../../src/billing/usageSummary.js";
import { getPlanDefinition } from "../../../src/billing/plans.js";

describe("buildBillingStatusText", () => {
  const freePlan = getPlanDefinition("free");
  const proPlan = getPlanDefinition("pro");

  it("includes the organization name", () => {
    const text = buildBillingStatusText({
      plan: freePlan,
      user: {
        displayName: "My Workspace",
        planCode: "free",
        subscriptionStatus: "free",
        currentPeriodEnd: null,
      },
      month: "2026-04",
      acceptedBillable: 0,
      egressBytes: 0n,
      storageBytes: 0n,
      aliasesUsed: 0,
    });
    expect(text).toContain("My Workspace");
  });

  it("HTML-escapes the organization name to prevent injection", () => {
    const text = buildBillingStatusText({
      plan: freePlan,
      user: {
        displayName: "<script>alert(1)</script>",
        planCode: "free",
        subscriptionStatus: "free",
        currentPeriodEnd: null,
      },
      month: "2026-04",
      acceptedBillable: 0,
      egressBytes: 0n,
      storageBytes: 0n,
      aliasesUsed: 0,
    });
    expect(text).not.toContain("<script>");
    expect(text).toContain("&lt;script&gt;");
  });

  it("shows the plan name and subscription status", () => {
    const text = buildBillingStatusText({
      plan: proPlan,
      user: {
        displayName: "Acme Co",
        planCode: "pro",
        subscriptionStatus: "active",
        currentPeriodEnd: new Date("2030-01-01T00:00:00Z"),
      },
      month: "2026-04",
      acceptedBillable: 42,
      egressBytes: 0n,
      storageBytes: 0n,
      aliasesUsed: 5,
    });
    expect(text).toContain("Pro");
    expect(text).toMatch(/active/i);
  });

  it("renders this-month accepted/billable count", () => {
    const text = buildBillingStatusText({
      plan: freePlan,
      user: {
        displayName: "Acme Co",
        planCode: "free",
        subscriptionStatus: "free",
        currentPeriodEnd: null,
      },
      month: "2026-04",
      acceptedBillable: 17,
      egressBytes: 0n,
      storageBytes: 0n,
      aliasesUsed: 0,
    });
    expect(text).toMatch(/17/);
    expect(text).toContain("2026-04");
  });

  it("renders alias quota and storage estimate", () => {
    const text = buildBillingStatusText({
      plan: freePlan,
      user: {
        displayName: "Acme Co",
        planCode: "free",
        subscriptionStatus: "free",
        currentPeriodEnd: null,
      },
      month: "2026-04",
      acceptedBillable: 0,
      egressBytes: 50n * 1024n * 1024n,
      storageBytes: 30n * 1024n * 1024n,
      aliasesUsed: 2,
    });
    expect(text).toMatch(/Aliases[^\n]*2 \/ 3/);
    expect(text).toMatch(/Storage[^\n]*MB/);
  });

  it("escapes a tampered subscription status", () => {
    const text = buildBillingStatusText({
      plan: freePlan,
      user: {
        displayName: "Acme Co",
        planCode: "free",
        subscriptionStatus: "<b>fake</b>" as never,
        currentPeriodEnd: null,
      },
      month: "2026-04",
      acceptedBillable: 0,
      egressBytes: 0n,
      storageBytes: 0n,
      aliasesUsed: 0,
    });
    expect(text).not.toContain("<b>fake</b>");
    expect(text).toContain("&lt;b&gt;fake&lt;/b&gt;");
  });
});
