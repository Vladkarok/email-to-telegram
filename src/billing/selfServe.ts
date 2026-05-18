import type { AppConfig } from "../config.js";
import type { Messages } from "../i18n/index.js";
import { escapeHtml } from "../utils/html.js";

const DEFAULT_SUPPORT_CONTACT = "support";

export function resolveSupportContact(config: Pick<AppConfig, "supportContact">): string {
  return config.supportContact ?? DEFAULT_SUPPORT_CONTACT;
}

export function manualBillingMessage(
  config: Pick<AppConfig, "supportContact">,
  messages: Messages,
): string {
  return messages.billingCommands.manualBilling(escapeHtml(resolveSupportContact(config)));
}

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
