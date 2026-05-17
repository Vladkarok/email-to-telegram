import type { AppConfig } from "../config.js";
import type { Messages } from "../i18n/index.js";
import { escapeHtml } from "../utils/html.js";

export function donateHintSuffix(config: AppConfig, messages: Messages): string {
  if (config.billingProvider !== "donation" || !config.donationUrl) return "";
  return messages.donate.quotaHint(escapeHtml(config.donationUrl));
}
