import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../db/schema.js";
import { loadConfig } from "../config.js";
import { findUserById } from "../db/repos/users.js";
import { getStripeClient } from "./stripe.js";

type Db = NodePgDatabase<typeof schema>;

export async function createCustomerPortalSession(db: Db, userId: bigint): Promise<string | null> {
  const config = loadConfig();
  if (config.billingProvider !== "stripe") {
    throw new Error("Stripe billing is not configured");
  }

  const user = await findUserById(db, userId);
  if (!user?.stripeCustomerId) {
    return null;
  }

  const session = await getStripeClient(config).billingPortal.sessions.create({
    customer: user.stripeCustomerId,
    return_url: config.billingCancelUrl ?? config.publicBaseUrl,
  });
  return session.url;
}
