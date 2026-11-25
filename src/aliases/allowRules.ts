/**
 * Adding an allow-rule to an alias: the rules every caller shares, with no
 * Telegram in sight. The `/allow add` command, the quick-add buttons, the
 * pending text reply and the activation button all end in `insertAllowRule`;
 * each caller keeps its own transaction and locks (see Appendix A3 of the
 * 2026-11-21 deepen-delivery-and-admission contract).
 */
import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../db/schema.js";
import { emailAddresses, type EmailAddress } from "../db/schema.js";
import { addAllowRule, findAllowRuleByMatch } from "../db/repos/allowRules.js";
import {
  checkAllowRuleCreateLimit,
  withUserQuotaLock,
  type LimitResult,
} from "../billing/limits.js";
import type { ParsedAllowValue } from "../telegram/allowValue.js";

type Db = NodePgDatabase<typeof schema>;

/** The alias state a caller authorized against; see `insertAllowRule`. */
export interface ExpectedAliasSnapshot {
  chatId: bigint;
  routingVersion: number;
}

export type AllowRuleInsertResult =
  | { kind: "added" }
  | { kind: "duplicate" }
  | { kind: "limit"; limit: Exclude<LimitResult, { ok: true }> }
  | { kind: "stale" };

/**
 * Adds one allow rule: duplicate check, plan limit, insert. Runs on the
 * caller's handle, so the caller decides the transaction and the locks (the
 * owner's quota lock in hosted mode). With `expected`, the alias row is
 * locked first (`FOR UPDATE`) and nothing is written unless the alias is
 * still active, owned by `ownerId`, and on that chat and routing version.
 */
export async function insertAllowRule(
  tx: Db,
  input: {
    aliasId: string;
    ownerId: bigint;
    rule: ParsedAllowValue;
    expected?: ExpectedAliasSnapshot;
  },
): Promise<AllowRuleInsertResult> {
  if (input.expected) {
    const [current] = await tx
      .select({
        status: emailAddresses.status,
        createdBy: emailAddresses.createdBy,
        chatId: emailAddresses.chatId,
        routingVersion: emailAddresses.routingVersion,
      })
      .from(emailAddresses)
      .where(eq(emailAddresses.id, input.aliasId))
      .for("update");
    if (
      !current ||
      current.status !== "active" ||
      current.createdBy !== input.ownerId ||
      current.chatId !== input.expected.chatId ||
      current.routingVersion !== input.expected.routingVersion
    ) {
      return { kind: "stale" };
    }
  }

  const match = {
    emailAddressId: input.aliasId,
    matchType: input.rule.matchType,
    matchValue: input.rule.normalized,
  };
  if (await findAllowRuleByMatch(tx, match)) return { kind: "duplicate" };

  const limit = await checkAllowRuleCreateLimit(tx, input.ownerId);
  if (!limit.ok) return { kind: "limit", limit };

  await addAllowRule(tx, match);
  return { kind: "added" };
}

/**
 * The ordinary add (`/allow add`, quick-add, text reply): `insertAllowRule`
 * under the owner's quota lock. That lock is a pass-through outside hosted
 * mode, so self-hosted adds run on `db` itself with no transaction or owner
 * lock, as they always have. Without `expected` there is no snapshot check,
 * so the result is never `stale`.
 */
export async function addAllowRuleForOwner(
  db: Db,
  alias: Pick<EmailAddress, "id" | "createdBy">,
  rule: ParsedAllowValue,
): Promise<AllowRuleInsertResult> {
  return withUserQuotaLock(db, alias.createdBy, (tx) =>
    insertAllowRule(tx, { aliasId: alias.id, ownerId: alias.createdBy, rule }),
  );
}
