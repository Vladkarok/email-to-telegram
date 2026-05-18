import { describe, expect, it } from "vitest";
import type { StartupOptions } from "../../../src/cli.js";
import type { AppConfig } from "../../../src/config.js";
import {
  assertHostedManualBillingAllowed,
  buildManualBillingUserInput,
  hasHostedManualBillingOperation,
  hostedManualBillingExitCode,
  redactManualBillingForLog,
  withManualBillingWarnings,
} from "../../../src/startup/hostedManualBilling.js";

function startupOptions(overrides: Partial<StartupOptions>): StartupOptions {
  return {
    migrateOnly: false,
    rewrapStorageKeys: false,
    backfillStorageEncryption: false,
    hostedExportUserId: null,
    hostedExportOutputPath: null,
    hostedDeleteUserId: null,
    hostedSetUserPlanTelegramUserId: null,
    manualPlanCode: null,
    manualSubscriptionStatus: null,
    manualPaidThroughAt: null,
    manualPaymentReference: null,
    manualNote: null,
    manualKeepStripeLink: false,
    warnings: [],
    ...overrides,
  } as StartupOptions;
}

describe("hostedManualBilling helpers", () => {
  it("detects manual billing operations", () => {
    expect(hasHostedManualBillingOperation(startupOptions({}))).toBe(false);
    expect(
      hasHostedManualBillingOperation(startupOptions({ hostedSetUserPlanTelegramUserId: "12345" })),
    ).toBe(true);
  });

  it("rejects manual billing outside hosted mode", () => {
    expect(() => assertHostedManualBillingAllowed({ appMode: "self-hosted" } as AppConfig)).toThrow(
      /hosted/i,
    );
    expect(() =>
      assertHostedManualBillingAllowed({ appMode: "hosted" } as AppConfig),
    ).not.toThrow();
  });

  it("builds a user plan input from startup options", () => {
    const opts = startupOptions({
      hostedSetUserPlanTelegramUserId: "12345",
      manualPlanCode: "personal",
      manualSubscriptionStatus: "active",
      manualPaidThroughAt: new Date("2026-05-30T00:00:00.000Z"),
      manualPaymentReference: "wise-2026-05-001",
    });
    const input = buildManualBillingUserInput(opts);
    expect(input).toMatchObject({
      telegramUserId: 12345n,
      planCode: "personal",
      subscriptionStatus: "active",
      paidThroughAt: new Date("2026-05-30T00:00:00.000Z"),
      paymentReference: "wise-2026-05-001",
      keptStripeLink: false,
      operatorSource: "cli",
    });
  });

  it("throws when --manual-payment-reference is missing from user plan builder", () => {
    const opts = startupOptions({
      hostedSetUserPlanTelegramUserId: "12345",
      manualPlanCode: "pro",
      manualSubscriptionStatus: "active",
      manualPaidThroughAt: new Date("2026-05-30T00:00:00.000Z"),
    });
    expect(() => buildManualBillingUserInput(opts)).toThrow(/payment-reference/i);
  });

  it("redacts payment reference and note from log payloads", () => {
    const result = redactManualBillingForLog({
      telegramUserId: "12345",
      planCode: "pro",
      subscriptionStatus: "active",
      paidThroughAt: "2026-05-30T00:00:00.000Z",
      paymentReference: "wise-2026-05-001",
      note: "secret",
      keptStripeLink: false,
      manualBillingEventId: "evt-1",
      operatorSource: "cli",
    });
    expect(result.paymentReferencePresent).toBe(true);
    expect(result.notePresent).toBe(true);
    expect(result).not.toHaveProperty("paymentReference");
    expect(result).not.toHaveProperty("note");
  });

  it("computes exit code from result", () => {
    expect(hostedManualBillingExitCode({ ok: true } as never)).toBe(0);
    expect(hostedManualBillingExitCode({ ok: false } as never)).not.toBe(0);
  });

  it("adds manual billing warnings to stdout payloads when present", () => {
    const result = withManualBillingWarnings(
      { ok: true, idempotent: false, telegramUserId: "12345" } as never,
      ["warning text"],
    );
    expect(result).toMatchObject({ warnings: ["warning text"] });
  });
});
