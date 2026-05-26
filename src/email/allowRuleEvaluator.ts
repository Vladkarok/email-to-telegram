import type { AllowAuthRequirement, AllowMatchType } from "../db/repos/allowRules.js";

export interface AllowRuleForEvaluation {
  matchType: string;
  matchValue: string;
  authRequirement: string;
}

export interface SenderAuthForAllowRules {
  headerFromEmail: string | null;
  headerFromDomain: string | null;
  authenticatedDomains: string[];
  status: "pass" | "fail" | "temperror" | "permerror";
}

export type AllowEvaluationReason =
  | "sender_not_allowed"
  | "sender_auth_failed"
  | "sender_auth_temperror";

export interface AllowEvaluationResult {
  allowed: boolean;
  reason?: AllowEvaluationReason;
  matchedAuthRequirement?: AllowAuthRequirement;
}

export function evaluateAllowRules(
  rules: AllowRuleForEvaluation[],
  envelopeFrom: string,
  senderAuth?: SenderAuthForAllowRules,
): AllowEvaluationResult {
  if (rules.length === 0) return { allowed: false, reason: "sender_not_allowed" };
  if (matchesClaimedRule(rules, envelopeFrom)) {
    return { allowed: true, matchedAuthRequirement: "claimed" };
  }

  if (!senderAuth) {
    return { allowed: false, reason: "sender_not_allowed" };
  }

  if (
    !hasAuthenticatedRuleCandidate(rules, senderAuth.headerFromEmail, senderAuth.headerFromDomain)
  ) {
    return { allowed: false, reason: "sender_not_allowed" };
  }

  if (senderAuth.status === "temperror") {
    return { allowed: false, reason: "sender_auth_temperror" };
  }

  if (matchesAuthenticatedRule(rules, senderAuth)) {
    return { allowed: true, matchedAuthRequirement: "authenticated" };
  }

  return { allowed: false, reason: "sender_auth_failed" };
}

export function hasAuthenticatedRules(rules: AllowRuleForEvaluation[]): boolean {
  return rules.some((rule) => normalizeAuthRequirement(rule.authRequirement) === "authenticated");
}

export function hasAuthenticatedRuleCandidate(
  rules: AllowRuleForEvaluation[],
  headerFromEmail: string | null,
  headerFromDomain: string | null,
): boolean {
  return rules.some((rule) => {
    if (normalizeAuthRequirement(rule.authRequirement) !== "authenticated") return false;
    return matchesRuleIdentity(rule, headerFromEmail, headerFromDomain);
  });
}

function matchesClaimedRule(rules: AllowRuleForEvaluation[], envelopeFrom: string): boolean {
  const senderEmail = normalizeEmail(envelopeFrom);
  const senderDomain = domainFromEmail(senderEmail);
  return rules.some((rule) => {
    if (normalizeAuthRequirement(rule.authRequirement) !== "claimed") return false;
    return matchesRuleIdentity(rule, senderEmail, senderDomain);
  });
}

function matchesAuthenticatedRule(
  rules: AllowRuleForEvaluation[],
  senderAuth: SenderAuthForAllowRules,
): boolean {
  const headerFromEmail = normalizeEmail(senderAuth.headerFromEmail);
  const headerFromDomain = normalizeDomain(senderAuth.headerFromDomain);
  if (!headerFromDomain) return false;
  const authenticatedDomains = new Set(senderAuth.authenticatedDomains.map(normalizeDomain));
  if (!authenticatedDomains.has(headerFromDomain)) return false;

  return rules.some((rule) => {
    if (normalizeAuthRequirement(rule.authRequirement) !== "authenticated") return false;
    return matchesRuleIdentity(rule, headerFromEmail, headerFromDomain);
  });
}

function matchesRuleIdentity(
  rule: AllowRuleForEvaluation,
  email: string | null,
  domain: string | null,
): boolean {
  const matchValue = rule.matchValue.toLowerCase();
  const matchType = normalizeMatchType(rule.matchType);
  if (matchType === "exact_email") return email === matchValue;
  if (matchType === "domain") return domain === matchValue;
  return false;
}

function normalizeAuthRequirement(value: string): AllowAuthRequirement | null {
  return value === "claimed" || value === "authenticated" ? value : null;
}

function normalizeMatchType(value: string): AllowMatchType | null {
  return value === "exact_email" || value === "domain" ? value : null;
}

function normalizeEmail(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized && normalized.includes("@") ? normalized : null;
}

function normalizeDomain(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized && normalized.length > 0 ? normalized : null;
}

function domainFromEmail(email: string | null): string | null {
  return email?.split("@")[1] ?? null;
}
