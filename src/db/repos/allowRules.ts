import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { eq, and, count, ne } from "drizzle-orm";
import { allowRules, emailAddresses, type AllowRule, type NewAllowRule } from "../schema.js";
import type * as schema from "../schema.js";

type Db = NodePgDatabase<typeof schema>;

export type AllowAuthRequirement = "claimed" | "authenticated";
export type AllowMatchType = "exact_email" | "domain";

export async function addAllowRule(
  db: Db,
  data: Pick<NewAllowRule, "emailAddressId" | "matchType" | "matchValue"> & {
    authRequirement?: AllowAuthRequirement;
  },
): Promise<AllowRule> {
  const [rule] = await db
    .insert(allowRules)
    .values({ ...data, authRequirement: data.authRequirement ?? "claimed" })
    .returning();
  if (!rule) throw new Error("addAllowRule: no row returned");
  return rule;
}

export async function findAllowRuleByMatch(
  db: Db,
  data: Pick<NewAllowRule, "emailAddressId" | "matchType" | "matchValue"> & {
    authRequirement?: AllowAuthRequirement;
  },
): Promise<AllowRule | null> {
  const [rule] = await db
    .select()
    .from(allowRules)
    .where(
      and(
        eq(allowRules.emailAddressId, data.emailAddressId),
        eq(allowRules.matchType, data.matchType),
        eq(allowRules.matchValue, data.matchValue),
        eq(allowRules.authRequirement, data.authRequirement ?? "claimed"),
      ),
    )
    .limit(1);
  return rule ?? null;
}

export async function removeAllowRule(
  db: Db,
  data: Pick<NewAllowRule, "emailAddressId" | "matchValue"> & {
    authRequirement?: AllowAuthRequirement;
  },
): Promise<void> {
  const conditions = [
    eq(allowRules.emailAddressId, data.emailAddressId),
    eq(allowRules.matchValue, data.matchValue),
  ];
  if (data.authRequirement) {
    conditions.push(eq(allowRules.authRequirement, data.authRequirement));
  }

  await db.delete(allowRules).where(and(...conditions));
}

export async function findAllowRuleById(db: Db, id: string): Promise<AllowRule | null> {
  const [rule] = await db.select().from(allowRules).where(eq(allowRules.id, id)).limit(1);
  return rule ?? null;
}

export async function listAllowRules(db: Db, emailAddressId: string): Promise<AllowRule[]> {
  return db.select().from(allowRules).where(eq(allowRules.emailAddressId, emailAddressId));
}

export async function countAllowRulesByUser(db: Db, userId: bigint): Promise<number> {
  const [row] = await db
    .select({ count: count() })
    .from(allowRules)
    .innerJoin(emailAddresses, eq(emailAddresses.id, allowRules.emailAddressId))
    .where(and(eq(emailAddresses.createdBy, userId), ne(emailAddresses.status, "deleted")));
  return row?.count ?? 0;
}

export async function checkAllowRule(
  db: Db,
  emailAddressId: string,
  senderEmail: string,
): Promise<boolean> {
  const rules = await listAllowRules(db, emailAddressId);
  return checkClaimedRules(rules, senderEmail);
}

export function checkClaimedRules(
  rules: Pick<AllowRule, "matchType" | "matchValue" | "authRequirement">[],
  senderEmail: string,
): boolean {
  if (rules.length === 0) return false;
  const senderDomain = senderEmail.split("@")[1]?.toLowerCase() ?? "";
  const senderNorm = senderEmail.toLowerCase();

  return rules.some((r) => {
    if (r.authRequirement !== "claimed") return false;
    if (r.matchType === "exact_email") return r.matchValue.toLowerCase() === senderNorm;
    if (r.matchType === "domain") return r.matchValue.toLowerCase() === senderDomain;
    return false;
  });
}

export async function checkPreflightAllowRules(
  db: Db,
  emailAddressId: string,
  senderEmail: string,
): Promise<boolean> {
  const rules = await listAllowRules(db, emailAddressId);
  if (rules.length === 0) return false;
  if (checkClaimedRules(rules, senderEmail)) return true;
  return rules.some((rule) => rule.authRequirement === "authenticated");
}
