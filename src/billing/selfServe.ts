import type { AppConfig } from "../config.js";

export const MANUAL_BILLING_MESSAGE =
  "ℹ️ Self-serve payments are temporarily unavailable.\n\nHosted beta upgrades are handled manually for now. Contact support to upgrade, renew, cancel, or ask billing questions.";

export function isSelfServeBillingEnabled(
  config: Pick<AppConfig, "appMode" | "billingProvider">,
): boolean {
  return config.appMode === "hosted" && config.billingProvider === "stripe";
}

export function isManualBillingOrganization(organization: {
  planCode: string;
  stripeCustomerId?: string | null;
}): boolean {
  return organization.planCode !== "free" && !organization.stripeCustomerId;
}

export function canUseSelfServeBilling(
  config: Pick<AppConfig, "appMode" | "billingProvider">,
  organization: { planCode: string; stripeCustomerId?: string | null },
): boolean {
  return isSelfServeBillingEnabled(config) && !isManualBillingOrganization(organization);
}
