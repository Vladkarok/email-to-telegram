import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { billingWebhookEvents } from "../schema.js";
import type * as schema from "../schema.js";

type Db = NodePgDatabase<typeof schema>;

export async function recordBillingWebhookEvent(
  db: Db,
  eventId: string,
  eventType: string,
): Promise<boolean> {
  const rows = await db
    .insert(billingWebhookEvents)
    .values({ eventId, eventType })
    .onConflictDoNothing()
    .returning({ eventId: billingWebhookEvents.eventId });
  return rows.length > 0;
}
