import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { and, desc, eq } from "drizzle-orm";
import {
  manualBillingEvents,
  type ManualBillingEvent,
  type NewManualBillingEvent,
} from "../schema.js";
import type * as schema from "../schema.js";

type Db = NodePgDatabase<typeof schema>;

export type ManualBillingEventInput = Pick<
  NewManualBillingEvent,
  | "organizationId"
  | "telegramUserId"
  | "planCode"
  | "subscriptionStatus"
  | "paidThroughAt"
  | "paymentReference"
  | "note"
  | "keptStripeLink"
> &
  Partial<Pick<NewManualBillingEvent, "operatorSource">>;

export async function createManualBillingEvent(
  db: Db,
  data: ManualBillingEventInput,
): Promise<ManualBillingEvent> {
  const [row] = await db.insert(manualBillingEvents).values(data).returning();
  if (!row) throw new Error("createManualBillingEvent: no row returned");
  return row;
}

export async function findManualBillingEventByPaymentReference(
  db: Db,
  organizationId: string,
  paymentReference: string,
): Promise<ManualBillingEvent | null> {
  const [row] = await db
    .select()
    .from(manualBillingEvents)
    .where(
      and(
        eq(manualBillingEvents.organizationId, organizationId),
        eq(manualBillingEvents.paymentReference, paymentReference),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function listManualBillingEventsForOrganization(
  db: Db,
  organizationId: string,
): Promise<ManualBillingEvent[]> {
  return db
    .select()
    .from(manualBillingEvents)
    .where(eq(manualBillingEvents.organizationId, organizationId))
    .orderBy(desc(manualBillingEvents.createdAt));
}
