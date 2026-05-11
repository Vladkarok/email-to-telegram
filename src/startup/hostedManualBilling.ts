import type { StartupOptions } from "../cli.js";
import type { AppConfig } from "../config.js";
import type {
  AddManualOrganizationMemberInput,
  AddManualOrganizationMemberResult,
  GrantManualOrganizationPlanInput,
  GrantManualOrganizationPlanResult,
  GrantManualUserPlanInput,
  GrantManualUserPlanResult,
} from "../billing/manual.js";
export { redactManualBillingForLog } from "../billing/audit.js";

export function hasHostedManualBillingOperation(startup: StartupOptions): boolean {
  return Boolean(
    startup.hostedSetOrganizationPlanId ||
    startup.hostedSetUserPlanTelegramUserId ||
    startup.hostedAddOrganizationMemberId,
  );
}

export function assertHostedManualBillingAllowed(config: AppConfig): void {
  if (config.appMode !== "hosted") {
    throw new Error("Hosted manual billing commands require APP_MODE=hosted");
  }
}

export function buildManualBillingPlanInput(
  startup: StartupOptions,
): GrantManualOrganizationPlanInput {
  if (!startup.hostedSetOrganizationPlanId) {
    throw new Error("buildManualBillingPlanInput: hostedSetOrganizationPlanId is required");
  }
  if (!startup.manualPlanCode) {
    throw new Error("buildManualBillingPlanInput: manualPlanCode is required");
  }
  if (!startup.manualSubscriptionStatus) {
    throw new Error("buildManualBillingPlanInput: manualSubscriptionStatus is required");
  }
  if (!startup.manualPaymentReference) {
    throw new Error(
      "buildManualBillingPlanInput: --manual-payment-reference is required for idempotent retries",
    );
  }
  return {
    organizationId: startup.hostedSetOrganizationPlanId,
    planCode: startup.manualPlanCode,
    subscriptionStatus: startup.manualSubscriptionStatus,
    paidThroughAt: startup.manualPaidThroughAt,
    paymentReference: startup.manualPaymentReference,
    note: startup.manualNote,
    keptStripeLink: startup.manualKeepStripeLink,
    operatorSource: "cli",
  };
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
    organizationId: startup.manualOrganizationId,
    createNewOrganization: startup.manualCreateNewOrganization,
    planCode: startup.manualPlanCode,
    subscriptionStatus: startup.manualSubscriptionStatus,
    paidThroughAt: startup.manualPaidThroughAt,
    paymentReference: startup.manualPaymentReference,
    note: startup.manualNote,
    keptStripeLink: startup.manualKeepStripeLink,
    operatorSource: "cli",
  };
}

export function buildManualBillingMemberInput(
  startup: StartupOptions,
): AddManualOrganizationMemberInput {
  if (!startup.hostedAddOrganizationMemberId) {
    throw new Error("buildManualBillingMemberInput: hostedAddOrganizationMemberId is required");
  }
  if (!startup.manualTelegramUserId) {
    throw new Error("buildManualBillingMemberInput: manualTelegramUserId is required");
  }
  if (!startup.manualOrganizationRole) {
    throw new Error("buildManualBillingMemberInput: manualOrganizationRole is required");
  }
  return {
    organizationId: startup.hostedAddOrganizationMemberId,
    telegramUserId: BigInt(startup.manualTelegramUserId),
    role: startup.manualOrganizationRole,
  };
}

export function hostedManualBillingExitCode(
  result:
    | GrantManualOrganizationPlanResult
    | GrantManualUserPlanResult
    | AddManualOrganizationMemberResult,
): number {
  return result.ok ? 0 : 1;
}

export function withManualBillingWarnings<
  T extends GrantManualOrganizationPlanResult | GrantManualUserPlanResult,
>(result: T, warnings: readonly string[]): T | (T & { warnings: string[] }) {
  if (warnings.length === 0) return result;
  return { ...result, warnings: [...warnings] };
}
