import { loadConfig } from "../config.js";

export const ALIAS_IMPERSONATION_MESSAGE =
  "⛔ This alias name impersonates a reserved mailbox or a well-known brand. Please pick something else.";

export class AliasImpersonationError extends Error {
  constructor() {
    super("alias name impersonates a reserved mailbox or brand");
    this.name = "AliasImpersonationError";
  }
}

/** RFC 2142 reserved mailboxes + obvious generic admin names. */
const EXACT_BLOCKLIST: ReadonlySet<string> = new Set([
  "admin",
  "postmaster",
  "webmaster",
  "abuse",
  "security",
  "noreply",
  "no-reply",
  "support",
  "root",
  "hostmaster",
]);

/**
 * Brand-name substrings. Any alias containing one of these as a substring
 * is rejected. Maintenance burden accepted — list grows as abuse is observed.
 */
const BRAND_SUBSTRINGS: readonly string[] = [
  "paypal",
  "stripe",
  "amazon",
  "google",
  "microsoft",
  "apple",
  "github",
  "facebook",
  "meta",
  "instagram",
  "twitter",
  "tiktok",
  "youtube",
  "netflix",
  "spotify",
  "dropbox",
  "gitlab",
  "slack",
  "notion",
  "figma",
  "adobe",
  "coinbase",
  "binance",
  "kraken",
  "revolut",
  "wise",
  "chase",
  "bank",
  "barclays",
  "hsbc",
  "wellsfargo",
  "bankofamerica",
];

/**
 * Prefix patterns. Any alias starting with one of these (followed by anything)
 * is rejected. Covers `support-paypal`, `admin-google`, `verify-stripe`, etc.
 */
const PREFIX_BLOCKLIST: readonly string[] = [
  "support-",
  "admin-",
  "noreply-",
  "no-reply-",
  "security-",
  "billing-",
  "payments-",
  "account-",
  "verify-",
];

export function assertAliasNotImpersonation(rawName: string): void {
  if (!shouldEnforceImpersonationGuard()) return;

  const name = rawName.toLowerCase();

  if (EXACT_BLOCKLIST.has(name)) throw new AliasImpersonationError();

  for (const prefix of PREFIX_BLOCKLIST) {
    if (name.startsWith(prefix)) throw new AliasImpersonationError();
  }

  for (const brand of BRAND_SUBSTRINGS) {
    if (name.includes(brand)) throw new AliasImpersonationError();
  }
}

function shouldEnforceImpersonationGuard(): boolean {
  const appMode = process.env["APP_MODE"];
  if (appMode === "hosted") return true;
  if (appMode === "self-hosted") return false;

  try {
    return loadConfig().appMode === "hosted";
  } catch {
    return false;
  }
}
