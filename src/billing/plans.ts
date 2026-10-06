export type PlanCode = "free" | "personal" | "pro" | "team" | "business";

export type BillingInterval = "monthly" | "yearly";

export type SubscriptionStatus =
  | "free"
  | "trialing"
  | "active"
  | "paused"
  | "past_due"
  | "canceled"
  | "unpaid"
  | "incomplete"
  | "incomplete_expired";

export interface PlanLimits {
  aliases: number;
  allowRules: number;
  deliveredEmailsMonth: number;
  egressBytesMonth: number;
  storageBytes: number;
  maxMessageBytes: number;
  retentionDays: number;
  customDomains: number;
  /**
   * Per-alias flood guard: accepted mail per alias in a sliding hour. Applies
   * in both app modes (self-hosted uses the free plan's value); the monthly
   * quotas above are enforced only in hosted mode.
   */
  aliasEmailsPerHour: number;
}

export interface PlanDefinition {
  code: PlanCode;
  name: string;
  monthlyPriceUsd: number | null;
  yearlyPriceUsd: number | null;
  limits: PlanLimits;
}

const mib = 1024 * 1024;
const gib = 1024 * mib;

// Code defaults. The hosted operator overrides limits through PLAN_LIMITS
// (see config.ts); read plans through getPlanDefinition/listPlanDefinitions so
// overrides are never bypassed.
const PLAN_DEFAULTS = {
  free: {
    code: "free",
    name: "Free",
    monthlyPriceUsd: 0,
    yearlyPriceUsd: 0,
    limits: {
      aliases: 3,
      allowRules: 10,
      deliveredEmailsMonth: 200,
      egressBytesMonth: gib,
      storageBytes: 100 * mib,
      maxMessageBytes: 5 * mib,
      retentionDays: 7,
      customDomains: 0,
      aliasEmailsPerHour: 60,
    },
  },
  personal: {
    code: "personal",
    name: "Personal",
    monthlyPriceUsd: 5,
    yearlyPriceUsd: 48,
    limits: {
      aliases: 10,
      allowRules: 50,
      deliveredEmailsMonth: 1_000,
      egressBytesMonth: 10 * gib,
      storageBytes: gib,
      maxMessageBytes: 10 * mib,
      retentionDays: 30,
      customDomains: 0,
      aliasEmailsPerHour: 60,
    },
  },
  pro: {
    code: "pro",
    name: "Pro",
    monthlyPriceUsd: 12,
    yearlyPriceUsd: 120,
    limits: {
      aliases: 50,
      allowRules: 500,
      deliveredEmailsMonth: 10_000,
      egressBytesMonth: 100 * gib,
      storageBytes: 10 * gib,
      maxMessageBytes: 25 * mib,
      retentionDays: 90,
      customDomains: 0,
      aliasEmailsPerHour: 60,
    },
  },
  team: {
    code: "team",
    name: "Team",
    monthlyPriceUsd: 29,
    yearlyPriceUsd: 290,
    limits: {
      aliases: 200,
      allowRules: 2_000,
      deliveredEmailsMonth: 100_000,
      egressBytesMonth: 500 * gib,
      storageBytes: 50 * gib,
      maxMessageBytes: 25 * mib,
      retentionDays: 180,
      customDomains: 3,
      aliasEmailsPerHour: 60,
    },
  },
  business: {
    code: "business",
    name: "Business",
    monthlyPriceUsd: null,
    yearlyPriceUsd: null,
    limits: {
      aliases: 1_000,
      allowRules: 10_000,
      deliveredEmailsMonth: 1_000_000,
      egressBytesMonth: 5_000 * gib,
      storageBytes: 500 * gib,
      maxMessageBytes: 25 * mib,
      retentionDays: 365,
      customDomains: 25,
      aliasEmailsPerHour: 60,
    },
  },
} as const satisfies Record<PlanCode, PlanDefinition>;

export const PLAN_CODES = Object.keys(PLAN_DEFAULTS) as PlanCode[];
export const SELF_SERVE_PLAN_CODES = [
  "personal",
  "pro",
  "team",
] as const satisfies readonly Exclude<PlanCode, "free" | "business">[];
export const NON_FREE_PLAN_CODES = PLAN_CODES.filter((code) => code !== "free");

export type PlanLimitOverrides = Partial<Record<PlanCode, Partial<PlanLimits>>>;

let effectivePlans = buildEffectivePlans({});

/**
 * Replaces the effective plans with the code defaults plus `overrides`.
 * Always rebuilds from the defaults, so an earlier call never leaks into a
 * later one. Called once from main() right after config loads.
 */
export function applyPlanLimitOverrides(overrides: PlanLimitOverrides): void {
  effectivePlans = buildEffectivePlans(overrides);
}

function buildEffectivePlans(
  overrides: PlanLimitOverrides,
): Readonly<Record<PlanCode, PlanDefinition>> {
  const plans = {} as Record<PlanCode, PlanDefinition>;
  for (const code of PLAN_CODES) {
    const defaults = PLAN_DEFAULTS[code];
    plans[code] = Object.freeze({
      ...defaults,
      limits: Object.freeze({ ...defaults.limits, ...overrides[code] }),
    });
  }
  return Object.freeze(plans);
}

export function isPlanCode(value: string): value is PlanCode {
  return Object.hasOwn(PLAN_DEFAULTS, value);
}

export function getPlanDefinition(code: PlanCode): PlanDefinition {
  return effectivePlans[code];
}

export function listPlanDefinitions(): readonly PlanDefinition[] {
  return PLAN_CODES.map((code) => effectivePlans[code]);
}
