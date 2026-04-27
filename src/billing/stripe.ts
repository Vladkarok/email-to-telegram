import Stripe from "stripe";
import { loadConfig, type AppConfig, type StripePriceIds } from "../config.js";
import type { PlanCode } from "./plans.js";

type BillingInterval = "monthly" | "yearly";

export type StripePriceKey =
  | "personal_monthly"
  | "personal_yearly"
  | "pro_monthly"
  | "pro_yearly"
  | "team_monthly"
  | "team_yearly";

export interface ResolvedStripePrice {
  priceId: string;
  planCode: Exclude<PlanCode, "free" | "business">;
  billingInterval: BillingInterval;
}

let cachedClient: Stripe | null = null;
let cachedSecretKey: string | null = null;

const PRICE_KEY_DETAILS: Record<
  StripePriceKey,
  { planCode: ResolvedStripePrice["planCode"]; billingInterval: BillingInterval }
> = {
  personal_monthly: { planCode: "personal", billingInterval: "monthly" },
  personal_yearly: { planCode: "personal", billingInterval: "yearly" },
  pro_monthly: { planCode: "pro", billingInterval: "monthly" },
  pro_yearly: { planCode: "pro", billingInterval: "yearly" },
  team_monthly: { planCode: "team", billingInterval: "monthly" },
  team_yearly: { planCode: "team", billingInterval: "yearly" },
};

export function isStripePriceKey(value: string): value is StripePriceKey {
  return value in PRICE_KEY_DETAILS;
}

export function getStripeClient(config = loadConfig()): Stripe {
  if (config.billingProvider !== "stripe" || !config.stripeSecretKey) {
    throw new Error("Stripe billing is not configured");
  }

  if (cachedClient && cachedSecretKey === config.stripeSecretKey) {
    return cachedClient;
  }

  cachedSecretKey = config.stripeSecretKey;
  cachedClient = new Stripe(config.stripeSecretKey);
  return cachedClient;
}

export function constructWebhookEvent(
  rawBody: Buffer,
  signature: string,
  config = loadConfig(),
): Stripe.Event {
  if (config.billingProvider !== "stripe" || !config.stripeWebhookSecret) {
    throw new Error("Stripe billing is not configured");
  }

  return getStripeClient(config).webhooks.constructEvent(
    rawBody,
    signature,
    config.stripeWebhookSecret,
  );
}

export function resolveStripePrice(
  priceIds: StripePriceIds,
  priceKey: StripePriceKey,
): ResolvedStripePrice {
  const details = PRICE_KEY_DETAILS[priceKey];
  const priceIdMap: Record<StripePriceKey, string> = {
    personal_monthly: priceIds.personalMonthly,
    personal_yearly: priceIds.personalYearly,
    pro_monthly: priceIds.proMonthly,
    pro_yearly: priceIds.proYearly,
    team_monthly: priceIds.teamMonthly,
    team_yearly: priceIds.teamYearly,
  };

  return {
    priceId: priceIdMap[priceKey],
    planCode: details.planCode,
    billingInterval: details.billingInterval,
  };
}

export function resolvePlanFromStripePriceId(
  config: Pick<AppConfig, "stripePriceIds">,
  priceId: string | null | undefined,
): ResolvedStripePrice | null {
  if (!config.stripePriceIds || !priceId) return null;

  const entries = Object.entries({
    personal_monthly: config.stripePriceIds.personalMonthly,
    personal_yearly: config.stripePriceIds.personalYearly,
    pro_monthly: config.stripePriceIds.proMonthly,
    pro_yearly: config.stripePriceIds.proYearly,
    team_monthly: config.stripePriceIds.teamMonthly,
    team_yearly: config.stripePriceIds.teamYearly,
  }) as Array<[StripePriceKey, string]>;

  const matched = entries.find(([, configuredPriceId]) => configuredPriceId === priceId);
  if (!matched) return null;
  return resolveStripePrice(config.stripePriceIds, matched[0]);
}
