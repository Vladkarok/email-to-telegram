import { describe, expect, it } from "vitest";
import { adminOperatorSource, redactManualBillingForLog } from "../../../src/billing/audit.js";
import type { ManualGrantSummary } from "../../../src/billing/manual.js";

function makeSummary(overrides: Partial<ManualGrantSummary> = {}): ManualGrantSummary {
  return {
    telegramUserId: "12345",
    planCode: "pro",
    subscriptionStatus: "active",
    paidThroughAt: "2025-12-31T00:00:00.000Z",
    paymentReference: "inv-001",
    note: "manual upgrade",
    keptStripeLink: false,
    manualBillingEventId: "evt-abc",
    operatorSource: "cli",
    ...overrides,
  };
}

describe("adminOperatorSource", () => {
  it("returns a string with admin: prefix", () => {
    const source = adminOperatorSource("supersecretadminpassword1234567890");
    expect(source).toMatch(/^admin:[0-9a-f]{16}$/);
  });

  it("is stable — same secret always yields the same fingerprint", () => {
    const secret = "supersecretadminpassword1234567890";
    expect(adminOperatorSource(secret)).toBe(adminOperatorSource(secret));
  });

  it("different secrets produce different fingerprints", () => {
    const a = adminOperatorSource("supersecretadminpassword1234567890");
    const b = adminOperatorSource("anothersecretpasswordxyzabcdef0123");
    expect(a).not.toBe(b);
  });

  it("fingerprint does not contain the raw secret", () => {
    const secret = "supersecretadminpassword1234567890";
    const source = adminOperatorSource(secret);
    expect(source).not.toContain(secret);
  });
});

describe("redactManualBillingForLog", () => {
  it("replaces paymentReference with presence flag when present", () => {
    const result = redactManualBillingForLog(makeSummary({ paymentReference: "inv-001" }));
    expect(result.paymentReferencePresent).toBe(true);
    expect(result).not.toHaveProperty("paymentReference");
  });

  it("sets paymentReferencePresent false when null", () => {
    const result = redactManualBillingForLog(makeSummary({ paymentReference: null }));
    expect(result.paymentReferencePresent).toBe(false);
  });

  it("sets paymentReferencePresent false when empty string", () => {
    const result = redactManualBillingForLog(makeSummary({ paymentReference: "" }));
    expect(result.paymentReferencePresent).toBe(false);
  });

  it("replaces note with presence flag when present", () => {
    const result = redactManualBillingForLog(makeSummary({ note: "some note" }));
    expect(result.notePresent).toBe(true);
    expect(result).not.toHaveProperty("note");
  });

  it("sets notePresent false when null", () => {
    const result = redactManualBillingForLog(makeSummary({ note: null }));
    expect(result.notePresent).toBe(false);
  });

  it("preserves non-sensitive fields", () => {
    const result = redactManualBillingForLog(
      makeSummary({
        telegramUserId: "99999",
        planCode: "team",
        subscriptionStatus: "canceled",
        paidThroughAt: null,
        keptStripeLink: true,
        manualBillingEventId: "evt-xyz",
      }),
    );
    expect(result.telegramUserId).toBe("99999");
    expect(result.planCode).toBe("team");
    expect(result.subscriptionStatus).toBe("canceled");
    expect(result.paidThroughAt).toBeNull();
    expect(result.keptStripeLink).toBe(true);
    expect(result.manualBillingEventId).toBe("evt-xyz");
  });

  it("includes operatorSource from summary", () => {
    const result = redactManualBillingForLog(
      makeSummary({ operatorSource: "admin:abcdef1234567890" }),
    );
    expect(result.operatorSource).toBe("admin:abcdef1234567890");
  });
});
