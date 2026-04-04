import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { eq, and } from "drizzle-orm";
import { allowRules, type AllowRule, type NewAllowRule } from "../schema.js";
import type * as schema from "../schema.js";

type Db = NodePgDatabase<typeof schema>;

export async function addAllowRule(
  db: Db,
  data: Pick<NewAllowRule, "emailAddressId" | "matchType" | "matchValue">,
): Promise<AllowRule> {
  const [rule] = await db.insert(allowRules).values(data).returning();
  if (!rule) throw new Error("addAllowRule: no row returned");
  return rule;
}

export async function removeAllowRule(
  db: Db,
  data: Pick<NewAllowRule, "emailAddressId" | "matchValue">,
): Promise<void> {
  await db
    .delete(allowRules)
    .where(
      and(
        eq(allowRules.emailAddressId, data.emailAddressId),
        eq(allowRules.matchValue, data.matchValue),
      ),
    );
}

export async function listAllowRules(db: Db, emailAddressId: string): Promise<AllowRule[]> {
  return db.select().from(allowRules).where(eq(allowRules.emailAddressId, emailAddressId));
}

export async function checkAllowRule(
  db: Db,
  emailAddressId: string,
  senderEmail: string,
): Promise<boolean> {
  const rules = await listAllowRules(db, emailAddressId);
  if (rules.length === 0) return false;

  const senderDomain = senderEmail.split("@")[1]?.toLowerCase() ?? "";
  const senderNorm = senderEmail.toLowerCase();

  return rules.some((r) => {
    if (r.matchType === "exact_email") return r.matchValue.toLowerCase() === senderNorm;
    if (r.matchType === "domain") return r.matchValue.toLowerCase() === senderDomain;
    return false;
  });
}
