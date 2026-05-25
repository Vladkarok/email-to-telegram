import { InlineKeyboard } from "grammy";
import type { CommandContext, Context } from "grammy";
import { CB_BILLING_UPGRADE } from "../callbacks.js";
import { getDb } from "../../db/client.js";
import type { EmailAddress } from "../../db/schema.js";
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
} from "../../billing/limits.js";
import { parseAllowValue } from "../allowValue.js";
import { escapeHtml } from "../../utils/html.js";
import { loadConfig } from "../../config.js";
import { donateHintSuffix } from "../donateHint.js";
import { getMessages, resolveLocale } from "../../i18n/index.js";
import { aliasResolutionError, resolveManageableAlias } from "../aliasResolver.js";

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
    const lines = rules
      .map((r) => `• ${r.matchType === "domain" ? "🌐" : "📧"} ${escapeHtml(r.matchValue)}`)
      .join("\n");
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
  let blockedLimit: Awaited<ReturnType<typeof checkAllowRuleCreateLimit>> | null = null;
  let duplicateRule = false;

  try {
    await withUserQuotaLock(db, alias.createdBy, async (tx) => {
      const existingRule = await findAllowRuleByMatch(tx, {
        emailAddressId: alias.id,
        matchType: parsedValue.matchType,
        matchValue: parsedValue.normalized,
      });
      if (existingRule) {
        duplicateRule = true;
        return;
      }

      const lockedLimit = await checkAllowRuleCreateLimit(tx, alias.createdBy);
      if (!lockedLimit.ok) {
        blockedLimit = lockedLimit;
        throw new Error("quota-blocked");
      }

      await addAllowRule(tx, {
        emailAddressId: alias.id,
        matchType: parsedValue.matchType,
        matchValue: parsedValue.normalized,
      });
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "quota-blocked") {
      if (blockedLimit) await replyForAllowRuleLimitFailure(ctx, alias.localPart, blockedLimit);
      return false;
    }
    throw err;
  }

  const icon = parsedValue.matchType === "domain" ? "🌐" : "📧";
  const value_escaped = escapeHtml(parsedValue.normalized);
  const localPart_escaped = escapeHtml(alias.localPart);

  if (duplicateRule) {
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
    const text =
      messages.allowCommand.limitReached(
        escapeHtml(localPart),
        limit.used ?? limitValue,
        limitValue,
      ) + donateHintSuffix(loadConfig(), messages, "html");
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
    return;
  }

  await ctx.reply(messages.allowCommand.createUnavailable);
}
