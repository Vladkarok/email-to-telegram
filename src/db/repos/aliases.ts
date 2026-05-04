import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { eq, and, ne, isNull, count } from "drizzle-orm";
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
    | "organizationId"
    | "domainId"
    | "chatId"
    | "messageThreadId"
    | "createdBy"
    | "renderMode"
    | "privacyModeEnabled"
    | "bodyDedupEnabled"
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
    .where(and(eq(emailAddresses.localPart, localPart), isNull(emailAddresses.domainId)));
  return alias ?? null;
}

export async function findAliasByFullAddress(
  db: Db,
  fullAddress: string,
): Promise<EmailAddress | null> {
  const [alias] = await db
    .select()
    .from(emailAddresses)
    .where(
      and(
        eq(emailAddresses.fullAddress, fullAddress.toLowerCase()),
        ne(emailAddresses.status, "deleted"),
      ),
    );
  return alias ?? null;
}

export async function findAliasByLocalPartAnyDomain(
  db: Db,
  localPart: string,
): Promise<EmailAddress | null> {
  const [alias] = await db
    .select()
    .from(emailAddresses)
    .where(and(eq(emailAddresses.localPart, localPart), ne(emailAddresses.status, "deleted")));
  return alias ?? null;
}

export async function findAliasByLocalPartAndDomainId(
  db: Db,
  localPart: string,
  domainId: string,
): Promise<EmailAddress | null> {
  const [alias] = await db
    .select()
    .from(emailAddresses)
    .where(and(eq(emailAddresses.localPart, localPart), eq(emailAddresses.domainId, domainId)));
  return alias ?? null;
}

export async function findAliasesByLocalPartForOrganization(
  db: Db,
  localPart: string,
  organizationId: string,
): Promise<EmailAddress[]> {
  return db
    .select()
    .from(emailAddresses)
    .where(
      and(
        eq(emailAddresses.localPart, localPart),
        eq(emailAddresses.organizationId, organizationId),
        ne(emailAddresses.status, "deleted"),
      ),
    );
}

export async function listAliasesByChat(db: Db, chatId: bigint): Promise<EmailAddress[]> {
  return db
    .select()
    .from(emailAddresses)
    .where(and(eq(emailAddresses.chatId, chatId), ne(emailAddresses.status, "deleted")));
}

export async function countActiveAliasesByOrganization(
  db: Db,
  organizationId: string,
): Promise<number> {
  const [row] = await db
    .select({ count: count() })
    .from(emailAddresses)
    .where(
      and(eq(emailAddresses.organizationId, organizationId), ne(emailAddresses.status, "deleted")),
    );
  return row?.count ?? 0;
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

export async function updateAliasBodyDedup(
  db: Db,
  id: string,
  bodyDedupEnabled: boolean,
): Promise<void> {
  await db
    .update(emailAddresses)
    .set({ bodyDedupEnabled, updatedAt: new Date() })
    .where(eq(emailAddresses.id, id));
}

export async function updateAliasPrivacyMode(
  db: Db,
  id: string,
  privacyModeEnabled: boolean,
): Promise<void> {
  await db
    .update(emailAddresses)
    .set({ privacyModeEnabled, updatedAt: new Date() })
    .where(eq(emailAddresses.id, id));
}

export async function updateAliasLabel(db: Db, id: string, label: string | null): Promise<void> {
  await db
    .update(emailAddresses)
    .set({ label, updatedAt: new Date() })
    .where(eq(emailAddresses.id, id));
}
