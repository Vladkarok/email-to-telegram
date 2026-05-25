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
  "noreply", // also matches "no-reply" once separators are stripped
  "support",
  "root",
  "hostmaster",
]);

/**
 * Prefix tokens. A name matches if these letters appear as a prefix of
 * the input (allowing separators between letters) AND the following
 * character is a separator, digit, or end-of-string. Continuous English
 * letters after the prefix (administrator, accountant, billings,
 * verified) are NOT blocked.
 *
 * Some entries are also in EXACT_BLOCKLIST (admin, support, noreply,
 * security). That is intentional and harmless: EXACT short-circuits
 * first; the prefix entry handles the trailing-modifier cases.
 */
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
 * stripped + de-leet form catches pay.pal, p_aypal, g00gle.
 * Length ≥6 chars and no English-word collisions; short tokens go in
 * BRAND_SHORT_BOUNDED.
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
 * would block "metabolism", "banking", "otherwise", "pineapple",
 * "chaser", "slackline", "appleton". Instead we require either
 * (a) the brand sits at a separator/digit boundary in the candidate
 * (meta-help, bank.alert, apple1) or (b) the user introduced separators
 * within the brand itself so stripping exposes it (app.le, b-a-n-k).
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
  (b) => [b, new RegExp(`(?:^|[._\\d-])${b}(?:[._\\d-]|$)`)] as const,
);

const LEET_MAP_BASE: Readonly<Record<string, string>> = {
  "0": "o",
  "3": "e",
  "4": "a",
  "5": "s",
  "@": "a",
};

// '1' is leet-ambiguous (i in adm1n, l in app1e). leetVariants() expands
// each '1' independently across both substitutions, so a brand with both
// 'i' and 'l' (gitlab, netflix) is matched on the right combination.
// Cap at 2^5 = 32 combos for inputs with ≤5 '1's; degenerate inputs with
// more fall back to the all-i / all-l pair (good enough; no realistic
// brand has >5 i+l positions).
const MAX_LEET_ONES_EXPANDED = 5;

function leetVariants(lower: string): readonly string[] {
  const ones: number[] = [];
  for (let i = 0; i < lower.length; i++) {
    if (lower[i] === "1") ones.push(i);
  }

  const base = lower.replace(/[0345@]/g, (c) => LEET_MAP_BASE[c] ?? c);

  if (ones.length === 0) return [base];

  if (ones.length > MAX_LEET_ONES_EXPANDED) {
    const allI = base.replace(/1/g, "i");
    const allL = base.replace(/1/g, "l");
    return allI === allL ? [allI] : [allI, allL];
  }

  const results = new Set<string>();
  const chars = base.split("");
  const total = 1 << ones.length;
  for (let mask = 0; mask < total; mask++) {
    for (let j = 0; j < ones.length; j++) {
      chars[ones[j]] = (mask >> j) & 1 ? "l" : "i";
    }
    results.add(chars.join(""));
  }
  return [...results];
}

function stripSeparators(s: string): string {
  return s.replace(/[._-]/g, "");
}

/**
 * Returns true if `candidate` starts with `prefix` (skipping separators
 * between prefix letters) AND the character immediately after the
 * matched prefix is a separator, digit, or end-of-string.
 *
 * Catches: admin, admin-x, admin.x, admin1, no-reply-foo, n-o-r-e-p-l-y.
 * Does NOT catch: administrator, accountant, billings, verified
 * (continuous English letters after the prefix).
 */
function matchesPrefixAtBoundary(candidate: string, prefix: string): boolean {
  let prefixIdx = 0;
  for (let i = 0; i < candidate.length; i++) {
    const c = candidate[i];
    const isSep = c === "." || c === "_" || c === "-";
    if (prefixIdx === prefix.length) {
      return isSep || (c >= "0" && c <= "9");
    }
    if (isSep) continue;
    if (c !== prefix[prefixIdx]) return false;
    prefixIdx++;
  }
  return prefixIdx === prefix.length;
}

function matchesAnyBlocklist(candidate: string, stripped: string): boolean {
  if (EXACT_BLOCKLIST.has(stripped)) return true;

  for (const prefix of PREFIX_BLOCKLIST) {
    if (matchesPrefixAtBoundary(candidate, prefix)) return true;
  }

  for (const brand of BRAND_SUBSTRINGS_LONG) {
    if (stripped.includes(brand)) return true;
  }

  const separatorsStripped = candidate !== stripped;
  for (const [brand, boundaryRe] of SHORT_BRAND_BOUNDARY_RE) {
    if (boundaryRe.test(candidate)) return true;
    if (separatorsStripped && stripped.includes(brand)) return true;
  }

  return false;
}

export function assertAliasNotImpersonation(rawName: string): void {
  if (!shouldEnforceImpersonationGuard()) return;

  const lower = rawName.toLowerCase();
  const candidates = new Set<string>([lower, ...leetVariants(lower)]);

  for (const candidate of candidates) {
    const stripped = stripSeparators(candidate);
    if (matchesAnyBlocklist(candidate, stripped)) {
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
