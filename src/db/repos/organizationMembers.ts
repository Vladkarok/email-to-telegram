import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { and, eq, inArray } from "drizzle-orm";
import {
  organizationMembers,
  type NewOrganizationMember,
  type OrganizationMember,
} from "../schema.js";
import type * as schema from "../schema.js";

type Db = NodePgDatabase<typeof schema>;

export type OrganizationRole = "owner" | "admin" | "member";

export async function addOrganizationMember(
  db: Db,
  data: Pick<NewOrganizationMember, "organizationId" | "userId"> & { role: OrganizationRole },
): Promise<OrganizationMember> {
  const [member] = await db
    .insert(organizationMembers)
    .values(data)
    .onConflictDoUpdate({
      target: [organizationMembers.organizationId, organizationMembers.userId],
      set: { role: data.role },
    })
    .returning();
  if (!member) throw new Error("addOrganizationMember: no row returned");
  return member;
}

export async function findOrganizationMember(
  db: Db,
  organizationId: string,
  userId: bigint,
): Promise<OrganizationMember | null> {
  const [member] = await db
    .select()
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.organizationId, organizationId),
        eq(organizationMembers.userId, userId),
      ),
    );
  return member ?? null;
}

export async function listOrganizationMembers(
  db: Db,
  organizationId: string,
): Promise<OrganizationMember[]> {
  return db
    .select()
    .from(organizationMembers)
    .where(eq(organizationMembers.organizationId, organizationId));
}

export async function listOrganizationMembershipsForUser(
  db: Db,
  userId: bigint,
): Promise<OrganizationMember[]> {
  return db.select().from(organizationMembers).where(eq(organizationMembers.userId, userId));
}

export async function userHasOrganizationRole(
  db: Db,
  organizationId: string,
  userId: bigint,
  roles: readonly OrganizationRole[],
): Promise<boolean> {
  const [member] = await db
    .select({ organizationId: organizationMembers.organizationId })
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.organizationId, organizationId),
        eq(organizationMembers.userId, userId),
        inArray(organizationMembers.role, [...roles]),
      ),
    )
    .limit(1);
  return member != null;
}
