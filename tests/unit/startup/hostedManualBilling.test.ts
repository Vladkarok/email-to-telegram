import { describe, expect, it } from "vitest";
import type { StartupOptions } from "../../../src/cli.js";
import type { AppConfig } from "../../../src/config.js";
import {
  assertHostedManualBillingAllowed,
  buildManualBillingPlanInput,
  buildManualBillingUserInput,
  buildManualBillingMemberInput,
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
    hostedExportOrganizationId: null,
    hostedExportOutputPath: null,
    hostedDeleteOrganizationId: null,
    hostedSetOrganizationPlanId: null,
    hostedSetUserPlanTelegramUserId: null,
    hostedAddOrganizationMemberId: null,
    manualPlanCode: null,
    manualSubscriptionStatus: null,
    manualPaidThroughAt: null,
    manualPaymentReference: null,
    manualNote: null,
    manualTelegramUserId: null,
    manualOrganizationId: null,
    manualOrganizationRole: null,
    manualKeepStripeLink: false,
    manualCreateNewOrganization: false,
    warnings: [],
    ...overrides,
  };
}

describe("hostedManualBilling helpers", () => {
  it("detects manual billing operations", () => {
    expect(hasHostedManualBillingOperation(startupOptions({}))).toBe(false);
    expect(
      hasHostedManualBillingOperation(startupOptions({ hostedSetOrganizationPlanId: "org-1" })),
    ).toBe(true);
    expect(
      hasHostedManualBillingOperation(startupOptions({ hostedSetUserPlanTelegramUserId: "12345" })),
    ).toBe(true);
    expect(
      hasHostedManualBillingOperation(startupOptions({ hostedAddOrganizationMemberId: "org-1" })),
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

  it("builds an organization plan input from startup options", () => {
    const opts = startupOptions({
      hostedSetOrganizationPlanId: "org-1",
      manualPlanCode: "pro",
      manualSubscriptionStatus: "active",
      manualPaidThroughAt: new Date("2026-05-30T00:00:00.000Z"),
      manualPaymentReference: "wise-2026-04-001",
      manualNote: "Manual Wise",
      manualKeepStripeLink: false,
    });
    const input = buildManualBillingPlanInput(opts);
    expect(input).toEqual({
      organizationId: "org-1",
      planCode: "pro",
      subscriptionStatus: "active",
      paidThroughAt: new Date("2026-05-30T00:00:00.000Z"),
      paymentReference: "wise-2026-04-001",
      note: "Manual Wise",
      keptStripeLink: false,
      operatorSource: "cli",
    });
  });

  it("builds a user plan input including organizationId and createNewOrganization", () => {
    const opts = startupOptions({
      hostedSetUserPlanTelegramUserId: "12345",
      manualPlanCode: "personal",
      manualSubscriptionStatus: "active",
      manualPaidThroughAt: new Date("2026-05-30T00:00:00.000Z"),
      manualOrganizationId: "org-x",
      manualCreateNewOrganization: true,
    });
    const input = buildManualBillingUserInput(opts);
    expect(input).toEqual({
      telegramUserId: 12345n,
      organizationId: "org-x",
      createNewOrganization: true,
      planCode: "personal",
      subscriptionStatus: "active",
      paidThroughAt: new Date("2026-05-30T00:00:00.000Z"),
      paymentReference: null,
      note: null,
      keptStripeLink: false,
      operatorSource: "cli",
    });
  });

  it("builds a member input from startup options", () => {
    const opts = startupOptions({
      hostedAddOrganizationMemberId: "org-1",
      manualTelegramUserId: "999",
      manualOrganizationRole: "member",
    });
    const input = buildManualBillingMemberInput(opts);
    expect(input).toEqual({
      organizationId: "org-1",
      telegramUserId: 999n,
      role: "member",
    });
  });

  it("redacts payment reference and note from log payloads", () => {
    const log = redactManualBillingForLog({
      organizationId: "org-1",
      telegramUserId: "12345",
      planCode: "pro",
      subscriptionStatus: "active",
      paidThroughAt: "2026-05-30T00:00:00.000Z",
      paymentReference: "wise-2026-04-001",
      note: "Operator chat with Bob said he paid by wire",
      keptStripeLink: false,
      manualBillingEventId: "event-1",
    });
    expect(log).toEqual({
      organizationId: "org-1",
      telegramUserId: "12345",
      planCode: "pro",
      subscriptionStatus: "active",
      paidThroughAt: "2026-05-30T00:00:00.000Z",
      paymentReferencePresent: true,
      notePresent: true,
      keptStripeLink: false,
      manualBillingEventId: "event-1",
      operatorSource: "cli",
    });
  });

  it("computes exit code from result", () => {
    expect(hostedManualBillingExitCode({ ok: true } as never)).toBe(0);
    expect(
      hostedManualBillingExitCode({ ok: false, code: "organization_not_found" } as never),
    ).toBe(1);
  });

  it("adds manual billing warnings to stdout payloads when present", () => {
    const result = {
      ok: true,
      idempotent: false,
      updated: true,
      organizationId: "org-1",
      telegramUserId: null,
      planCode: "pro",
      subscriptionStatus: "active",
      paidThroughAt: "2026-05-30T00:00:00.000Z",
      paymentReference: null,
      note: null,
      keptStripeLink: false,
      manualBillingEventId: "event-1",
    } as const;

    expect(withManualBillingWarnings(result, [])).toBe(result);
    expect(withManualBillingWarnings(result, ["backfill warning"])).toEqual({
      ...result,
      warnings: ["backfill warning"],
    });
  });
});
