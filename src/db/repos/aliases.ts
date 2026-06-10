import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { eq, and, ne, isNull, count, desc, gt, like, lt, notExists, sql } from "drizzle-orm";
import { customAlphabet } from "nanoid";
import {
  deliveryLogs,
  emailAddresses,
  type EmailAddress,
  type NewEmailAddress,
} from "../schema.js";
import type * as schema from "../schema.js";

type Db = NodePgDatabase<typeof schema>;

/**
 * Tombstone marker appended to soft-deleted alias names. `~` is outside the
 * alias NAME_RE alphabet, so tombstones can never collide with user input.
 */
export const ALIAS_TOMBSTONE_MARKER = "~del~";

const tombstoneSuffix = customAlphabet("abcdefghijklmnopqrstuvwxyz0123456789", 8);

/** Escapes `%`, `_` and `\` so a name can be embedded in a LIKE pattern. */
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

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

export async function listAliasesByChat(db: Db, chatId: bigint): Promise<EmailAddress[]> {
  return db
    .select()
    .from(emailAddresses)
    .where(and(eq(emailAddresses.chatId, chatId), ne(emailAddresses.status, "deleted")));
}

export async function countActiveAliasesByUser(db: Db, userId: bigint): Promise<number> {
  const [row] = await db
    .select({ count: count() })
    .from(emailAddresses)
    .where(and(eq(emailAddresses.createdBy, userId), ne(emailAddresses.status, "deleted")));
  return row?.count ?? 0;
}

export async function countAliasesByStatus(
  db: Db,
): Promise<Array<{ status: string; count: number }>> {
  const rows = await db
    .select({ status: emailAddresses.status, count: count() })
    .from(emailAddresses)
    .groupBy(emailAddresses.status);
  return rows.map((row) => ({ status: row.status, count: Number(row.count) }));
}

export async function updateAliasStatus(
  db: Db,
  id: string,
  status: "active" | "paused",
): Promise<void> {
  await db
    .update(emailAddresses)
    .set({ status, updatedAt: new Date() })
    .where(eq(emailAddresses.id, id));
}

/**
 * Soft-deletes an alias and frees its name: local_part and full_address are
 * renamed with a `~del~<id>` tombstone suffix in the same UPDATE, so the
 * unique indexes no longer reserve the original name.
 */
export async function softDeleteAlias(db: Db, id: string): Promise<void> {
  const tombstoneTag = `${ALIAS_TOMBSTONE_MARKER}${tombstoneSuffix()}`;
  await db
    .update(emailAddresses)
    .set({
      localPart: sql`${emailAddresses.localPart} || ${tombstoneTag}`,
      fullAddress: sql`${emailAddresses.localPart} || ${tombstoneTag} || '@' || split_part(${emailAddresses.fullAddress}, '@', 2)`,
      status: "deleted",
      updatedAt: new Date(),
    })
    .where(eq(emailAddresses.id, id));
}

/**
 * Hard-deletes tombstones older than `cutoff` that no delivery log references
 * anymore (log retention purges those on its own schedule). Until then the
 * tombstone preserves delivery history and feeds the name-reuse cooldown.
 * Returns the number of purged rows.
 */
export async function deleteExpiredAliasTombstones(db: Db, cutoff: Date): Promise<number> {
  const result = await db.delete(emailAddresses).where(
    and(
      eq(emailAddresses.status, "deleted"),
      like(emailAddresses.localPart, `%${ALIAS_TOMBSTONE_MARKER}%`),
      lt(emailAddresses.updatedAt, cutoff),
      // Parenthesized — drizzle's notExists() does not wrap raw SQL.
      notExists(
        sql`(select 1 from ${deliveryLogs} where ${deliveryLogs.emailAddressId} = ${emailAddresses.id})`,
      ),
    ),
  );
  return (result as unknown as { rowCount?: number }).rowCount ?? 0;
}

/**
 * Newest tombstone whose original name matches `localPart`, deleted after
 * `since`. Used for the cross-user name-reuse cooldown.
 */
export async function findRecentAliasTombstone(
  db: Db,
  localPart: string,
  since: Date,
): Promise<EmailAddress | null> {
  const pattern = `${escapeLikePattern(localPart)}${ALIAS_TOMBSTONE_MARKER}%`;
  const [alias] = await db
    .select()
    .from(emailAddresses)
    .where(
      and(
        like(emailAddresses.localPart, pattern),
        eq(emailAddresses.status, "deleted"),
        gt(emailAddresses.updatedAt, since),
      ),
    )
    .orderBy(desc(emailAddresses.updatedAt))
    .limit(1);
  return alias ?? null;
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
