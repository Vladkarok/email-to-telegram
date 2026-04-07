import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../db/schema.js";
import { createDeliveryViewLink } from "../db/repos/deliveryViewLinks.js";
import { generateDeliveryViewToken } from "../utils/tokens.js";

type Db = NodePgDatabase<typeof schema>;

export async function createPrivacyViewUrl(
  db: Db,
  deliveryLogId: string,
  publicBaseUrl: string,
  ttlHours: number,
): Promise<string> {
  const { token, expiresAt } = generateDeliveryViewToken(deliveryLogId, ttlHours);
  await createDeliveryViewLink(db, deliveryLogId, token, expiresAt);
  return `${publicBaseUrl}/view/${token}`;
}
