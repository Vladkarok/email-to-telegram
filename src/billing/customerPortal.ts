import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../db/schema.js";
import { loadConfig } from "../config.js";
import { findOrganizationById } from "../db/repos/organizations.js";
import { getStripeClient } from "./stripe.js";

type Db = NodePgDatabase<typeof schema>;

export async function createCustomerPortalSession(
  db: Db,
  organizationId: string,
): Promise<string | null> {
  const config = loadConfig();
  if (config.billingProvider !== "stripe") {
    throw new Error("Stripe billing is not configured");
  }

  const organization = await findOrganizationById(db, organizationId);
  if (!organization?.stripeCustomerId) {
    return null;
  }

  const session = await getStripeClient(config).billingPortal.sessions.create({
    customer: organization.stripeCustomerId,
    return_url: config.billingCancelUrl ?? config.publicBaseUrl,
  });
  return session.url;
}
