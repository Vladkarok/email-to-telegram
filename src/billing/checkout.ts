import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import type * as schema from "../db/schema.js";
import { loadConfig } from "../config.js";
import { findUserByIdForUpdate, updateUserBillingState } from "../db/repos/users.js";
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

  const stripe = getStripeClient(config);
  const resolvedPrice = resolveStripePrice(config.stripePriceIds, priceKey);
  const userIdStr = userId.toString();

  // Serialize per-user checkout creation so two concurrent calls cannot each
  // create a distinct Stripe customer (the losing one would orphan, and any
  // subsequent paid subscription on that customer would be rejected by the
  // webhook's customer-id mismatch guard). The advisory lock matches the one
  // used by the manual billing path.
  const customerId = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${userId})`);
    const user = await findUserByIdForUpdate(tx as Db, userId);
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
    if (user.stripeCustomerId) {
      return user.stripeCustomerId;
    }

    const name = user.username ? `@${user.username}` : `Telegram ${userIdStr}`;
    const customer = await stripe.customers.create(
      {
        name,
        metadata: { telegramUserId: userIdStr },
      },
      { idempotencyKey: `customer-create:${userIdStr}` },
    );
    await updateUserBillingState(tx as Db, user.id, {
      stripeCustomerId: customer.id,
    });
    return customer.id;
  });

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
