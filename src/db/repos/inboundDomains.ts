import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { and, eq } from "drizzle-orm";
import { inboundDomains, type InboundDomain, type NewInboundDomain } from "../schema.js";
import type * as schema from "../schema.js";

type Db = NodePgDatabase<typeof schema>;

export type InboundDomainKind = "shared" | "custom";
export type InboundDomainStatus = "active" | "pending" | "disabled";

export async function createInboundDomain(
  db: Db,
  data: Pick<NewInboundDomain, "domain" | "kind"> &
    Partial<
      Pick<NewInboundDomain, "organizationId" | "status" | "verificationToken" | "verifiedAt">
    >,
): Promise<InboundDomain> {
  const [domain] = await db
    .insert(inboundDomains)
    .values({ ...data, domain: data.domain.toLowerCase() })
    .returning();
  if (!domain) throw new Error("createInboundDomain: no row returned");
  return domain;
}

export async function ensureSharedInboundDomain(db: Db, domain: string): Promise<InboundDomain> {
  const normalizedDomain = domain.toLowerCase();
  const existing = await findInboundDomainByDomain(db, normalizedDomain);
  if (existing) {
    if (existing.kind !== "shared" || existing.status !== "active") {
      throw new Error("ensureSharedInboundDomain: hosted shared domain is not active");
    }
    return existing;
  }

  const [created] = await db
    .insert(inboundDomains)
    .values({ domain: normalizedDomain, kind: "shared", status: "active" })
    .onConflictDoNothing({ target: inboundDomains.domain })
    .returning();
  if (created) return created;

  const raced = await findInboundDomainByDomain(db, normalizedDomain);
  if (!raced) throw new Error("ensureSharedInboundDomain: no row returned");
  if (raced.kind !== "shared" || raced.status !== "active") {
    throw new Error("ensureSharedInboundDomain: hosted shared domain is not active");
  }
  return raced;
}

export async function findInboundDomainByDomain(
  db: Db,
  domain: string,
): Promise<InboundDomain | null> {
  const [row] = await db
    .select()
    .from(inboundDomains)
    .where(eq(inboundDomains.domain, domain.toLowerCase()));
  return row ?? null;
}

export async function findActiveInboundDomainByDomain(
  db: Db,
  domain: string,
): Promise<InboundDomain | null> {
  const [row] = await db
    .select()
    .from(inboundDomains)
    .where(
      and(eq(inboundDomains.domain, domain.toLowerCase()), eq(inboundDomains.status, "active")),
    );
  return row ?? null;
}

export async function listInboundDomainsByOrganization(
  db: Db,
  organizationId: string,
): Promise<InboundDomain[]> {
  return db.select().from(inboundDomains).where(eq(inboundDomains.organizationId, organizationId));
}

export async function updateInboundDomainStatus(
  db: Db,
  id: string,
  status: InboundDomainStatus,
): Promise<InboundDomain | null> {
  const [domain] = await db
    .update(inboundDomains)
    .set({ status, updatedAt: new Date() })
    .where(eq(inboundDomains.id, id))
    .returning();
  return domain ?? null;
}
