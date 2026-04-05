import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { eq, and, ne } from "drizzle-orm";
import { emailAddresses, type EmailAddress, type NewEmailAddress } from "../schema.js";
import type * as schema from "../schema.js";

type Db = NodePgDatabase<typeof schema>;

export async function findAliasById(db: Db, id: string): Promise<EmailAddress | null> {
  const [alias] = await db.select().from(emailAddresses).where(eq(emailAddresses.id, id));
  return alias ?? null;
}

export async function findAliasesByCreator(db: Db, createdBy: bigint): Promise<EmailAddress[]> {
  return db
    .select()
    .from(emailAddresses)
    .where(and(eq(emailAddresses.createdBy, createdBy), ne(emailAddresses.status, "deleted")));
}

export async function createAlias(
  db: Db,
  data: Pick<
    NewEmailAddress,
    | "localPart"
    | "fullAddress"
    | "chatId"
    | "messageThreadId"
    | "createdBy"
    | "renderMode"
    | "status"
  >,
): Promise<EmailAddress> {
  const [alias] = await db.insert(emailAddresses).values(data).returning();
  if (!alias) throw new Error("createAlias: no row returned");
  return alias;
}

export async function findAliasByLocalPart(
  db: Db,
  localPart: string,
): Promise<EmailAddress | null> {
  const [alias] = await db
    .select()
    .from(emailAddresses)
    .where(eq(emailAddresses.localPart, localPart));
  return alias ?? null;
}

export async function findAliasByIdAndChat(
  db: Db,
  localPart: string,
  chatId: bigint,
): Promise<EmailAddress | null> {
  const [alias] = await db
    .select()
    .from(emailAddresses)
    .where(and(eq(emailAddresses.localPart, localPart), eq(emailAddresses.chatId, chatId)));
  return alias ?? null;
}

export async function listAliasesByChat(db: Db, chatId: bigint): Promise<EmailAddress[]> {
  return db
    .select()
    .from(emailAddresses)
    .where(and(eq(emailAddresses.chatId, chatId), ne(emailAddresses.status, "deleted")));
}

export async function updateAliasStatus(
  db: Db,
  id: string,
  status: "active" | "paused" | "deleted",
): Promise<void> {
  await db
    .update(emailAddresses)
    .set({ status, updatedAt: new Date() })
    .where(eq(emailAddresses.id, id));
}

export async function updateAliasRenderMode(
  db: Db,
  id: string,
  renderMode: "plaintext" | "html" | "markdown",
): Promise<void> {
  await db
    .update(emailAddresses)
    .set({ renderMode, updatedAt: new Date() })
    .where(eq(emailAddresses.id, id));
}
