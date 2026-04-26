import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import type * as schema from "../db/schema.js";
import type { Organization, User } from "../db/schema.js";
import { createOrganization, findOrganizationById } from "../db/repos/organizations.js";
import {
  addOrganizationMember,
  listOrganizationMembershipsForUser,
} from "../db/repos/organizationMembers.js";

type Db = NodePgDatabase<typeof schema>;

export async function getPrimaryOrganizationForUser(
  db: Db,
  userId: bigint,
): Promise<Organization | null> {
  const memberships = await listOrganizationMembershipsForUser(db, userId);
  const membership = memberships[0];
  if (!membership) return null;
  return findOrganizationById(db, membership.organizationId);
}

export async function ensurePersonalOrganizationForUser(db: Db, user: User): Promise<Organization> {
  return db.transaction(async (tx) => {
    const transactionalDb = tx as Db;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${user.id.toString()}))`);

    const existing = await getPrimaryOrganizationForUser(transactionalDb, user.id);
    if (existing) return existing;

    const organization = await createOrganization(transactionalDb, {
      name: personalOrganizationName(user),
      planCode: "free",
      subscriptionStatus: "free",
    });
    await addOrganizationMember(transactionalDb, {
      organizationId: organization.id,
      userId: user.id,
      role: "owner",
    });
    return organization;
  });
}

function personalOrganizationName(user: Pick<User, "username" | "id">): string {
  return user.username ? `@${user.username}` : `Telegram ${user.id.toString()}`;
}
