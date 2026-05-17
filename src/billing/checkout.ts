import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../db/schema.js";
import { loadConfig } from "../config.js";
import { findUserById, updateUserBillingState } from "../db/repos/users.js";
import { getStripeClient, resolveStripePrice, type StripePriceKey } from "./stripe.js";

type Db = NodePgDatabase<typeof schema>;

export class BillingCheckoutConflictError extends Error {
  constructor(message = "User already has a Stripe subscription") {
    super(message);
    this.name = "BillingCheckoutConflictError";
  }
}

export async function createCheckoutSession(
  db: Db,
  userId: bigint,
  priceKey: StripePriceKey,
): Promise<string> {
  const config = loadConfig();
  if (config.billingProvider !== "stripe" || !config.stripePriceIds) {
    throw new Error("Stripe billing is not configured");
  }

  const user = await findUserById(db, userId);
  if (!user) {
    throw new Error("User not found");
  }
  if (
    user.stripeSubscriptionId &&
    user.subscriptionStatus !== "canceled" &&
    user.subscriptionStatus !== "free" &&
    user.subscriptionStatus !== "incomplete_expired"
  ) {
    throw new BillingCheckoutConflictError();
  }

  const stripe = getStripeClient(config);
  const resolvedPrice = resolveStripePrice(config.stripePriceIds, priceKey);
  let customerId = user.stripeCustomerId ?? null;
  const userIdStr = user.id.toString();
  const displayName = user.username ? `@${user.username}` : `Telegram ${userIdStr}`;

  if (!customerId) {
    const customer = await stripe.customers.create({
      name: displayName,
      metadata: { telegramUserId: userIdStr },
    });
    customerId = customer.id;
    await updateUserBillingState(db, user.id, {
      stripeCustomerId: customerId,
    });
  }

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    success_url: config.billingSuccessUrl!,
    cancel_url: config.billingCancelUrl!,
    client_reference_id: userIdStr,
    line_items: [{ price: resolvedPrice.priceId, quantity: 1 }],
    metadata: {
      telegramUserId: userIdStr,
      planCode: resolvedPrice.planCode,
      billingInterval: resolvedPrice.billingInterval,
    },
    subscription_data: {
      metadata: {
        telegramUserId: userIdStr,
      },
    },
  });

  if (!session.url) {
    throw new Error("Stripe checkout session did not include a URL");
  }

  return session.url;
}
