import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { count, eq, sql } from "drizzle-orm";
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
        | "paidThroughAt"
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

export async function findOrganizationByIdForUpdate(
  db: Db,
  id: string,
): Promise<Organization | null> {
  const [organization] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, id))
    .for("update");
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
      | "paidThroughAt"
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

export async function updateOrganizationPaidThroughAtIfLater(
  db: Db,
  id: string,
  paidThroughAt: Date,
): Promise<Organization | null> {
  const [organization] = await db
    .update(organizations)
    .set({
      paidThroughAt: sql`case when ${organizations.paidThroughAt} is null or ${organizations.paidThroughAt} < ${paidThroughAt} then ${paidThroughAt} else ${organizations.paidThroughAt} end`,
      updatedAt: new Date(),
    })
    .where(eq(organizations.id, id))
    .returning();
  return organization ?? null;
}

export async function countOrganizationsByPlan(
  db: Db,
): Promise<Array<{ planCode: string; count: number }>> {
  const rows = await db
    .select({ planCode: organizations.planCode, count: count() })
    .from(organizations)
    .groupBy(organizations.planCode);

  return rows.map((row) => ({ planCode: row.planCode, count: Number(row.count) }));
}
