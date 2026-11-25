/**
 * Rows the delivery Postgres suites start from: an owner, an active alias,
 * and delivery logs for it. Use with a database from pgTestDb.ts.
 */
import { eq } from "drizzle-orm";
import * as schema from "../../src/db/schema.js";
import type { TestDb } from "./pgTestDb.js";

export const DELIVERY_RAW_PATH = "/data/rawemails/2026-11-21/log.eml";

/** Truncates the delivery tables, then inserts the owner and an active alias in `chatId`. */
export async function seedOwnerAndAlias(
  db: TestDb,
  { owner, chatId = owner }: { owner: bigint; chatId?: bigint },
): Promise<schema.EmailAddress> {
  await db.execute("truncate users, chats, email_addresses, delivery_logs cascade");
  await db.insert(schema.users).values({ id: owner, isAllowed: true, locale: "en" });
  const [alias] = await db
    .insert(schema.emailAddresses)
    .values({
      localPart: "inbox",
      fullAddress: "inbox@mail.example.com",
      chatId,
      createdBy: owner,
      status: "active",
    })
    .returning();
  return alias;
}

export async function seedDeliveryLog(
  db: TestDb,
  alias: Pick<schema.EmailAddress, "id" | "createdBy">,
  values: Partial<schema.NewDeliveryLog> = {},
): Promise<schema.DeliveryLog> {
  const [log] = await db
    .insert(schema.deliveryLogs)
    .values({
      emailAddressId: alias.id,
      userId: alias.createdBy,
      finalStatus: "processing",
      rawEmailPath: DELIVERY_RAW_PATH,
      rawEmailEncryptionMode: "envelope",
      rawEmailWrappedDek: "wrapped",
      rawEmailKekKeyId: "kek-1",
      rawEmailEncryptedAt: new Date(),
      ...values,
    })
    .returning();
  return log;
}

export async function readDeliveryLog(db: TestDb, id: string): Promise<schema.DeliveryLog> {
  const [log] = await db.select().from(schema.deliveryLogs).where(eq(schema.deliveryLogs.id, id));
  return log;
}
