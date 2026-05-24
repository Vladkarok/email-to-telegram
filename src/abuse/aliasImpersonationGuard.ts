import { loadConfig } from "../config.js";

export const ALIAS_IMPERSONATION_MESSAGE =
  "⛔ This alias name impersonates a reserved mailbox or a well-known brand. Please pick something else.";

export class AliasImpersonationError extends Error {
  constructor() {
    super("alias name impersonates a reserved mailbox or brand");
    this.name = "AliasImpersonationError";
  }
}

// All blocklist entries below are stored in stripped + de-leet form.
// Input is normalized the same way before matching so attackers cannot
// bypass with separators (pay.pal, b-a-n-k) or leet-speak (g00gle, adm1n).

/** RFC 2142 reserved mailboxes + obvious generic admin names. */
const EXACT_BLOCKLIST: ReadonlySet<string> = new Set([
  "admin",
  "postmaster",
  "webmaster",
  "abuse",
  "security",
  "noreply", // matches "no-reply" once separators are stripped
  "support",
  "root",
  "hostmaster",
]);

/** Prefix patterns matched against the stripped + de-leet form. */
const PREFIX_BLOCKLIST: readonly string[] = [
  "support",
  "admin",
  "noreply",
  "security",
  "billing",
  "payments",
  "account",
  "verify",
];

/**
 * Long, unambiguous brand names. Plain substring match against the
 * stripped + de-leet form catches pay.pal, p_aypal, g00gle, etc.
 * Names ≥6 chars only — short tokens go in BRAND_SHORT_BOUNDED to
 * avoid blocking English words.
 */
const BRAND_SUBSTRINGS_LONG: readonly string[] = [
  "paypal",
  "stripe",
  "amazon",
  "google",
  "microsoft",
  "github",
  "facebook",
  "instagram",
  "twitter",
  "tiktok",
  "youtube",
  "netflix",
  "spotify",
  "dropbox",
  "gitlab",
  "coinbase",
  "binance",
  "kraken",
  "revolut",
  "barclays",
  "wellsfargo",
  "bankofamerica",
];

/**
 * Short or English-word-overlapping brand names. A raw substring match
 * here would block "metabolism", "banking", "otherwise", "pineapple",
 * "chaser", "slackline" — all legitimate names with no impersonation
 * intent. Instead we require either (a) the brand sits at a separator
 * boundary in the original (meta-help, bank.alert), or (b) the input
 * used separators inside the brand itself (app.le, b-a-n-k) — i.e.
 * stripping changed the string AND the brand is present in stripped.
 */
const BRAND_SHORT_BOUNDED: readonly string[] = [
  "meta",
  "bank",
  "wise",
  "chase",
  "apple",
  "hsbc",
  "slack",
  "adobe",
  "figma",
  "notion",
];

const SHORT_BRAND_BOUNDARY_RE: ReadonlyArray<readonly [string, RegExp]> = BRAND_SHORT_BOUNDED.map(
  (b) => [b, new RegExp(`(?:^|[._-])${b}(?:[._-]|$)`)] as const,
);

// `1` is leet-ambiguous: it stands for `i` (adm1n → admin) in some words
// and `l` (app1e → apple) in others. LEET_MAP_BASE covers the unambiguous
// substitutions; `1` is expanded into both candidates by leetVariants().
const LEET_MAP_BASE: Readonly<Record<string, string>> = {
  "0": "o",
  "3": "e",
  "4": "a",
  "5": "s",
  "@": "a",
};

function applyLeet(s: string, oneAs: "i" | "l"): string {
  return s.replace(/[01345@]/g, (c) => (c === "1" ? oneAs : (LEET_MAP_BASE[c] ?? c)));
}

function leetVariants(lower: string): readonly string[] {
  const asI = applyLeet(lower, "i");
  if (!lower.includes("1")) return [asI];
  const asL = applyLeet(lower, "l");
  return [asI, asL];
}

function stripSeparators(s: string): string {
  return s.replace(/[._-]/g, "");
}

function matchesAnyBlocklist(leet: string, stripped: string): boolean {
  if (EXACT_BLOCKLIST.has(stripped)) return true;

  for (const prefix of PREFIX_BLOCKLIST) {
    if (stripped.startsWith(prefix)) return true;
  }

  for (const brand of BRAND_SUBSTRINGS_LONG) {
    if (stripped.includes(brand)) return true;
  }

  for (const [brand, boundaryRe] of SHORT_BRAND_BOUNDARY_RE) {
    if (boundaryRe.test(leet)) return true;
    if (leet !== stripped && stripped.includes(brand)) return true;
  }

  return false;
}

export function assertAliasNotImpersonation(rawName: string): void {
  if (!shouldEnforceImpersonationGuard()) return;

  const lower = rawName.toLowerCase();
  for (const leet of leetVariants(lower)) {
    const stripped = stripSeparators(leet);
    if (matchesAnyBlocklist(leet, stripped)) {
      throw new AliasImpersonationError();
    }
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
