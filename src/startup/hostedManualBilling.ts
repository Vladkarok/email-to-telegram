import type { StartupOptions } from "../cli.js";
import type { AppConfig } from "../config.js";
import type { GrantManualUserPlanInput, GrantManualUserPlanResult } from "../billing/manual.js";
export { redactManualBillingForLog } from "../billing/audit.js";

export function hasHostedManualBillingOperation(startup: StartupOptions): boolean {
  return Boolean(startup.hostedSetUserPlanTelegramUserId);
}

export function assertHostedManualBillingAllowed(config: AppConfig): void {
  if (config.appMode !== "hosted") {
    throw new Error("Hosted manual billing commands require APP_MODE=hosted");
  }
}

export function buildManualBillingUserInput(startup: StartupOptions): GrantManualUserPlanInput {
  if (!startup.hostedSetUserPlanTelegramUserId) {
    throw new Error("buildManualBillingUserInput: hostedSetUserPlanTelegramUserId is required");
  }
  if (!startup.manualPlanCode) {
    throw new Error("buildManualBillingUserInput: manualPlanCode is required");
  }
  if (!startup.manualSubscriptionStatus) {
    throw new Error("buildManualBillingUserInput: manualSubscriptionStatus is required");
  }
  if (!startup.manualPaymentReference) {
    throw new Error(
      "buildManualBillingUserInput: --manual-payment-reference is required for idempotent retries",
    );
  }
  return {
    telegramUserId: BigInt(startup.hostedSetUserPlanTelegramUserId),
    planCode: startup.manualPlanCode,
    subscriptionStatus: startup.manualSubscriptionStatus,
    paidThroughAt: startup.manualPaidThroughAt,
    paymentReference: startup.manualPaymentReference,
    note: startup.manualNote,
    keptStripeLink: startup.manualKeepStripeLink,
    operatorSource: "cli",
  };
}

export function hostedManualBillingExitCode(result: GrantManualUserPlanResult): number {
  return result.ok ? 0 : 1;
}

export function withManualBillingWarnings<T extends GrantManualUserPlanResult>(
  result: T,
  warnings: readonly string[],
): T | (T & { warnings: string[] }) {
  if (warnings.length === 0) return result;
  return { ...result, warnings: [...warnings] };
}
