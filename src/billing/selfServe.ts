import type { AppConfig } from "../config.js";

export const MANUAL_BILLING_MESSAGE =
  "ℹ️ Self-serve payments are temporarily unavailable.\n\nHosted upgrades are handled manually for now. Contact support to upgrade, renew, cancel, or ask billing questions.";

export const MANUAL_BILLING_ALERT = "Self-serve payments are temporarily unavailable.";

export function isSelfServeBillingEnabled(
  config: Pick<AppConfig, "appMode" | "billingProvider">,
): boolean {
  return config.appMode === "hosted" && config.billingProvider === "stripe";
}

export function isManualBillingUser(user: {
  planCode: string;
  stripeCustomerId?: string | null;
}): boolean {
  return user.planCode !== "free" && !user.stripeCustomerId;
}

export function canUseSelfServeBilling(
  config: Pick<AppConfig, "appMode" | "billingProvider">,
  user: { planCode: string; stripeCustomerId?: string | null },
): boolean {
  return isSelfServeBillingEnabled(config) && !isManualBillingUser(user);
}
