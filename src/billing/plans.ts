export type PlanCode = "free" | "personal" | "pro" | "team" | "business";

export type BillingInterval = "monthly" | "yearly";

export type SubscriptionStatus =
  | "free"
  | "trialing"
  | "active"
  | "past_due"
  | "canceled"
  | "unpaid"
  | "incomplete";

export interface PlanLimits {
  aliases: number;
  users: number;
  chats: number;
  allowRules: number;
  deliveredEmailsMonth: number;
  storageBytes: number;
  maxMessageBytes: number;
  retentionDays: number;
  customDomains: number;
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

export const PLAN_DEFINITIONS = {
  free: {
    code: "free",
    name: "Free",
    monthlyPriceUsd: 0,
    yearlyPriceUsd: 0,
    limits: {
      aliases: 3,
      users: 1,
      chats: 1,
      allowRules: 10,
      deliveredEmailsMonth: 100,
      storageBytes: 100 * mib,
      maxMessageBytes: 5 * mib,
      retentionDays: 7,
      customDomains: 0,
    },
  },
  personal: {
    code: "personal",
    name: "Personal",
    monthlyPriceUsd: 5,
    yearlyPriceUsd: 48,
    limits: {
      aliases: 10,
      users: 1,
      chats: 3,
      allowRules: 50,
      deliveredEmailsMonth: 1_000,
      storageBytes: gib,
      maxMessageBytes: 10 * mib,
      retentionDays: 30,
      customDomains: 0,
    },
  },
  pro: {
    code: "pro",
    name: "Pro",
    monthlyPriceUsd: 12,
    yearlyPriceUsd: 120,
    limits: {
      aliases: 50,
      users: 3,
      chats: 10,
      allowRules: 500,
      deliveredEmailsMonth: 10_000,
      storageBytes: 10 * gib,
      maxMessageBytes: 25 * mib,
      retentionDays: 90,
      customDomains: 1,
    },
  },
  team: {
    code: "team",
    name: "Team",
    monthlyPriceUsd: 29,
    yearlyPriceUsd: 290,
    limits: {
      aliases: 200,
      users: 10,
      chats: 50,
      allowRules: 2_000,
      deliveredEmailsMonth: 100_000,
      storageBytes: 50 * gib,
      maxMessageBytes: 25 * mib,
      retentionDays: 180,
      customDomains: 3,
    },
  },
  business: {
    code: "business",
    name: "Business",
    monthlyPriceUsd: null,
    yearlyPriceUsd: null,
    limits: {
      aliases: 1_000,
      users: 100,
      chats: 250,
      allowRules: 10_000,
      deliveredEmailsMonth: 1_000_000,
      storageBytes: 500 * gib,
      maxMessageBytes: 25 * mib,
      retentionDays: 365,
      customDomains: 25,
    },
  },
} as const satisfies Record<PlanCode, PlanDefinition>;

export const PLAN_CODES = Object.keys(PLAN_DEFINITIONS) as PlanCode[];
export const SELF_SERVE_PLAN_CODES = [
  "personal",
  "pro",
  "team",
] as const satisfies readonly Exclude<PlanCode, "free" | "business">[];
export const NON_FREE_PLAN_CODES = PLAN_CODES.filter((code) => code !== "free");

export function isPlanCode(value: string): value is PlanCode {
  return Object.hasOwn(PLAN_DEFINITIONS, value);
}

export function getPlanDefinition(code: PlanCode): PlanDefinition {
  return PLAN_DEFINITIONS[code];
}
