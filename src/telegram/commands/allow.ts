import { InlineKeyboard } from "grammy";
import type { CommandContext, Context } from "grammy";
import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../../db/schema.js";
import { CB_BILLING_UPGRADE } from "../callbacks.js";
import { getDb } from "../../db/client.js";
import { emailAddresses, type EmailAddress } from "../../db/schema.js";
import {
  addAllowRule,
  findAllowRuleByMatch,
  removeAllowRule,
  listAllowRules,
} from "../../db/repos/allowRules.js";
import {
  checkAllowRuleCreateLimit,
  hasActiveHostedUser,
  withUserQuotaLock,
  type LimitResult,
} from "../../billing/limits.js";
import { parseAllowValue, type ParsedAllowValue } from "../allowValue.js";
import { escapeHtml } from "../../utils/html.js";
import { getMessages, resolveLocale } from "../../i18n/index.js";
import { aliasResolutionError, resolveManageableAlias } from "../aliasResolver.js";
import { allowRuleIcon } from "../allowRuleDisplay.js";

export async function allowHandler(ctx: CommandContext<Context>): Promise<void> {
  const parts = ctx.match.trim().split(/\s+/).filter(Boolean);
  const [subcommand, aliasName, value] = parts;

  const db = getDb();
  const locale = await resolveLocale(ctx, db);
  const messages = getMessages(locale);

  if (!subcommand || !["add", "remove", "list"].includes(subcommand)) {
    await ctx.reply(messages.allowCommand.usage);
    return;
  }

  if (!aliasName) {
    await ctx.reply(messages.allowCommand.usage);
    return;
  }

  if (!ctx.from || !ctx.chat) {
    await ctx.reply(messages.common.accessDenied);
    return;
  }

  const resolved = await resolveManageableAlias(
    db,
    ctx.api,
    ctx.from.id,
    BigInt(ctx.chat.id),
    aliasName,
    ctx.chat.type,
  );
  if (!resolved.ok) {
    await ctx.reply(aliasResolutionError(resolved, aliasName, ctx.chat.type, locale));
    return;
  }
  const alias = resolved.alias;

  if (!(await hasActiveHostedUser(db, alias.createdBy))) {
    await replyForAllowRuleLimitFailure(ctx, alias.localPart, {
      ok: false,
      code: "subscription_inactive",
    });
    return;
  }

  if (subcommand === "list") {
    const rules = await listAllowRules(db, alias.id);
    if (rules.length === 0) {
      await ctx.reply(messages.allowCommand.listEmpty(escapeHtml(aliasName)), {
        parse_mode: "HTML",
      });
      return;
    }
    const lines = rules.map((r) => `• ${allowRuleIcon()} ${escapeHtml(r.matchValue)}`).join("\n");
    await ctx.reply(messages.allowCommand.listHeader(escapeHtml(aliasName), lines), {
      parse_mode: "HTML",
    });
    return;
  }

  if (!value) {
    await ctx.reply(messages.allowCommand.usage);
    return;
  }

  if (subcommand === "add") {
    if (!(await addAllowRuleForAlias(ctx, db, alias, value))) {
      return;
    }
    return;
  }

  if (subcommand === "remove") {
    await removeAllowRule(db, {
      emailAddressId: alias.id,
      matchValue: value.toLowerCase(),
    });
    await ctx.reply(messages.allowCommand.removed(escapeHtml(aliasName), escapeHtml(value)), {
      parse_mode: "HTML",
    });
  }
}

export async function addAllowRuleForAlias(
  ctx: Context,
  db: ReturnType<typeof getDb>,
  alias: Pick<EmailAddress, "id" | "localPart" | "createdBy">,
  value: string,
): Promise<boolean> {
  const locale = await resolveLocale(ctx, db);
  const messages = getMessages(locale);
  const parsedValue = parseAllowValue(value);
  if (!parsedValue) {
    await ctx.reply(messages.allowCommand.invalidFormat, { parse_mode: "HTML" });
    return false;
  }
  const outcome = await withUserQuotaLock(db, alias.createdBy, (tx) =>
    insertAllowRule(tx, { aliasId: alias.id, ownerId: alias.createdBy, rule: parsedValue }),
  );
  if (outcome.kind === "limit") {
    await replyForAllowRuleLimitFailure(ctx, alias.localPart, outcome.limit);
    return false;
  }

  const icon = allowRuleIcon();
  const value_escaped = escapeHtml(parsedValue.normalized);
  const localPart_escaped = escapeHtml(alias.localPart);

  if (outcome.kind === "duplicate") {
    await ctx.reply(messages.allowCommand.alreadyExists(localPart_escaped, icon, value_escaped), {
      parse_mode: "HTML",
    });
    return true;
  }

  await ctx.reply(messages.allowCommand.added(localPart_escaped, icon, value_escaped), {
    parse_mode: "HTML",
  });
  return true;
}

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
  tx: NodePgDatabase<typeof schema>,
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

async function replyForAllowRuleLimitFailure(
  ctx: Context,
  localPart: string,
  limit: Awaited<ReturnType<typeof checkAllowRuleCreateLimit>>,
): Promise<void> {
  if (limit.ok) return;

  const messages = getMessages(await resolveLocale(ctx, getDb()));

  if (limit.code === "subscription_inactive") {
    await ctx.reply(messages.allowCommand.subscriptionInactive(escapeHtml(localPart)), {
      parse_mode: "HTML",
    });
    return;
  }

  if (limit.code === "allow_rule_limit") {
    const keyboard = new InlineKeyboard().text(
      messages.allowCommand.upgradePlanButton,
      CB_BILLING_UPGRADE,
    );
    const limitValue = limit.limit ?? 0;
    const text = messages.allowCommand.limitReached(
      escapeHtml(localPart),
      limit.used ?? limitValue,
      limitValue,
    );
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
    return;
  }

  await ctx.reply(messages.allowCommand.createUnavailable);
}
