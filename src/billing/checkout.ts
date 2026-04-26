import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../db/schema.js";
import { loadConfig } from "../config.js";
import { findOrganizationById, updateOrganizationBillingState } from "../db/repos/organizations.js";
import { getStripeClient, resolveStripePrice, type StripePriceKey } from "./stripe.js";

type Db = NodePgDatabase<typeof schema>;

export class BillingCheckoutConflictError extends Error {
  constructor(message = "Organization already has a Stripe subscription") {
    super(message);
    this.name = "BillingCheckoutConflictError";
  }
}

export async function createCheckoutSession(
  db: Db,
  organizationId: string,
  priceKey: StripePriceKey,
): Promise<string> {
  const config = loadConfig();
  if (config.billingProvider !== "stripe" || !config.stripePriceIds) {
    throw new Error("Stripe billing is not configured");
  }

  const organization = await findOrganizationById(db, organizationId);
  if (!organization) {
    throw new Error("Organization not found");
  }
  if (
    organization.stripeSubscriptionId &&
    organization.subscriptionStatus !== "canceled" &&
    organization.subscriptionStatus !== "free" &&
    organization.subscriptionStatus !== "incomplete_expired"
  ) {
    throw new BillingCheckoutConflictError();
  }

  const stripe = getStripeClient(config);
  const resolvedPrice = resolveStripePrice(config.stripePriceIds, priceKey);
  let customerId = organization.stripeCustomerId ?? null;

  if (!customerId) {
    const customer = await stripe.customers.create({
      name: organization.name,
      metadata: { organizationId: organization.id },
    });
    customerId = customer.id;
    await updateOrganizationBillingState(db, organization.id, {
      stripeCustomerId: customerId,
    });
  }

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    success_url: config.billingSuccessUrl!,
    cancel_url: config.billingCancelUrl!,
    client_reference_id: organization.id,
    line_items: [{ price: resolvedPrice.priceId, quantity: 1 }],
    metadata: {
      organizationId: organization.id,
      planCode: resolvedPrice.planCode,
      billingInterval: resolvedPrice.billingInterval,
    },
    subscription_data: {
      metadata: {
        organizationId: organization.id,
      },
    },
  });

  if (!session.url) {
    throw new Error("Stripe checkout session did not include a URL");
  }

  return session.url;
}
