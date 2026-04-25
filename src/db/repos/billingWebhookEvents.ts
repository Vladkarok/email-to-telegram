import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import {
  billingWebhookEvents,
  type BillingWebhookEvent,
  type NewBillingWebhookEvent,
} from "../schema.js";
import type * as schema from "../schema.js";

type Db = NodePgDatabase<typeof schema>;

export async function recordBillingWebhookEvent(
  db: Db,
  data: Pick<NewBillingWebhookEvent, "eventId" | "eventType">,
): Promise<BillingWebhookEvent | null> {
  const [event] = await db
    .insert(billingWebhookEvents)
    .values(data)
    .onConflictDoNothing()
    .returning();
  return event ?? null;
}

export async function findBillingWebhookEvent(
  db: Db,
  eventId: string,
): Promise<BillingWebhookEvent | null> {
  const [event] = await db
    .select()
    .from(billingWebhookEvents)
    .where(eq(billingWebhookEvents.eventId, eventId));
  return event ?? null;
}
