export type AllowMatchType = "exact_email" | "domain";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export interface ParsedAllowValue {
  normalized: string;
  matchType: AllowMatchType;
}

export function parseAllowValue(value: string): ParsedAllowValue | null {
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0) return null;

  if (normalized.includes("@")) {
    if (!EMAIL_RE.test(normalized)) return null;
    return { normalized, matchType: "exact_email" };
  }

  if (!DOMAIN_RE.test(normalized)) return null;
  return { normalized, matchType: "domain" };
}
