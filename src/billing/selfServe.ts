import type { AppConfig } from "../config.js";
import type { Messages } from "../i18n/index.js";
import { escapeHtml } from "../utils/html.js";

const DEFAULT_SUPPORT_CONTACT = "support";

export function resolveSupportContact(config: Pick<AppConfig, "supportContact">): string {
  return config.supportContact ?? DEFAULT_SUPPORT_CONTACT;
}

/**
 * In donation mode this instance must never read as selling subscriptions
 * (donations are gifts, not payment for service — the legal basis of the
 * model), so the copy points at the operator for limits and at /donate for
 * support. Other providers with self-serve disabled get the neutral
 * operator-managed message.
 */
export function manualBillingMessage(
  config: Pick<AppConfig, "supportContact" | "billingProvider">,
  messages: Messages,
): string {
  const contact = escapeHtml(resolveSupportContact(config));
  return config.billingProvider === "donation"
    ? messages.billingCommands.manualBillingDonation(contact)
    : messages.billingCommands.manualBilling(contact);
}

export function manualBillingAlert(messages: Messages): string {
  return messages.billingCommands.manualBillingAlert;
}

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
