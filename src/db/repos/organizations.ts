import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { organizations, type NewOrganization, type Organization } from "../schema.js";
import type * as schema from "../schema.js";

type Db = NodePgDatabase<typeof schema>;

export async function createOrganization(
  db: Db,
  data: Pick<NewOrganization, "name"> &
    Partial<
      Pick<
        NewOrganization,
        | "planCode"
        | "subscriptionStatus"
        | "stripeCustomerId"
        | "stripeSubscriptionId"
        | "trialEndsAt"
        | "currentPeriodStart"
        | "currentPeriodEnd"
      >
    >,
): Promise<Organization> {
  const [organization] = await db.insert(organizations).values(data).returning();
  if (!organization) throw new Error("createOrganization: no row returned");
  return organization;
}

export async function findOrganizationById(db: Db, id: string): Promise<Organization | null> {
  const [organization] = await db.select().from(organizations).where(eq(organizations.id, id));
  return organization ?? null;
}

export async function findOrganizationByStripeCustomerId(
  db: Db,
  stripeCustomerId: string,
): Promise<Organization | null> {
  const [organization] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.stripeCustomerId, stripeCustomerId));
  return organization ?? null;
}

export async function findOrganizationByStripeSubscriptionId(
  db: Db,
  stripeSubscriptionId: string,
): Promise<Organization | null> {
  const [organization] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.stripeSubscriptionId, stripeSubscriptionId));
  return organization ?? null;
}

export async function updateOrganizationBillingState(
  db: Db,
  id: string,
  data: Partial<
    Pick<
      NewOrganization,
      | "planCode"
      | "subscriptionStatus"
      | "stripeCustomerId"
      | "stripeSubscriptionId"
      | "trialEndsAt"
      | "currentPeriodStart"
      | "currentPeriodEnd"
    >
  >,
): Promise<Organization | null> {
  const [organization] = await db
    .update(organizations)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(organizations.id, id))
    .returning();
  return organization ?? null;
}
