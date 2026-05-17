import type { AppConfig } from "../config.js";
import type { Messages } from "../i18n/index.js";
import { escapeHtml } from "../utils/html.js";

export type DonateHintMode = "plain" | "html";

export function donateHintSuffix(
  config: AppConfig,
  messages: Messages,
  mode: DonateHintMode,
): string {
  if (config.billingProvider !== "donation" || !config.donationUrl) return "";
  const url = mode === "html" ? escapeHtml(config.donationUrl) : config.donationUrl;
  return messages.donate.quotaHint(url);
}
