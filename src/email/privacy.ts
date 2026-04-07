import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../db/schema.js";
import { createDeliveryViewLink } from "../db/repos/deliveryViewLinks.js";
import { generateDeliveryViewTokenForExpiry, hashStoredToken } from "../utils/tokens.js";

type Db = NodePgDatabase<typeof schema>;

export async function createPrivacyViewUrl(
  db: Db,
  deliveryLogId: string,
  publicBaseUrl: string,
  expiresAt: Date,
): Promise<string> {
  const { token } = generateDeliveryViewTokenForExpiry(deliveryLogId, expiresAt);
  await createDeliveryViewLink(db, deliveryLogId, hashStoredToken(token), expiresAt);
  return `${publicBaseUrl}/view/${token}`;
}
