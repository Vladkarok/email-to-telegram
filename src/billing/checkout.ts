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

  // Phase 1 — validate eligibility and read any existing customer under a
  // per-user advisory lock (matches the manual billing path). The lock is held
  // only for DB work, never across the Stripe network call.
  const phase1 = await db.transaction(async (tx) => {
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
    return { existingCustomerId: user.stripeCustomerId, username: user.username };
  });

  let customerId = phase1.existingCustomerId;

  if (!customerId) {
    // Phase 2 — create the Stripe customer outside any transaction. The
    // deterministic idempotency key makes concurrent or retried calls converge
    // on a single customer, so no advisory lock is needed to prevent orphans.
    const name = phase1.username ? `@${phase1.username}` : `Telegram ${userIdStr}`;
    const customer = await stripe.customers.create(
      { name, metadata: { telegramUserId: userIdStr } },
      { idempotencyKey: `customer-create:${userIdStr}` },
    );

    // Phase 3 — persist the customer id under the lock, deferring to any id a
    // concurrent checkout already stored (the shared idempotency key means it
    // is the same Stripe customer regardless).
    customerId = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${userId})`);
      const user = await findUserByIdForUpdate(tx as Db, userId);
      if (!user) {
        throw new Error("User not found");
      }
      if (user.stripeCustomerId) {
        return user.stripeCustomerId;
      }
      await updateUserBillingState(tx as Db, user.id, { stripeCustomerId: customer.id });
      return customer.id;
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
