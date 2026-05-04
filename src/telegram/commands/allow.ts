import { InlineKeyboard } from "grammy";
import type { CommandContext, Context } from "grammy";
import { CB_BILLING_UPGRADE } from "../callbacks.js";
import { getDb } from "../../db/client.js";
import { findAliasByFullAddress, findAliasByLocalPartAnyDomain } from "../../db/repos/aliases.js";
import type { EmailAddress } from "../../db/schema.js";
import {
  addAllowRule,
  findAllowRuleByMatch,
  removeAllowRule,
  listAllowRules,
} from "../../db/repos/allowRules.js";
import {
  checkAllowRuleCreateLimit,
  hasActiveHostedOrganization,
  withOrganizationQuotaLock,
} from "../../billing/limits.js";
import { canManageAlias } from "../authorization.js";
import { parseAllowValue } from "../allowValue.js";
import { escapeHtml } from "../../utils/html.js";

const USAGE = `Usage:
  /allow add <alias_or_address> <email_or_domain>
  /allow remove <alias_or_address> <email_or_domain>
  /allow list <alias_or_address>

Examples:
  /allow add alerts-ab12cd@example.com github.com
  /allow add alerts-ab12cd user@example.com
  /allow list alerts-ab12cd`;

export async function allowHandler(ctx: CommandContext<Context>): Promise<void> {
  const parts = ctx.match.trim().split(/\s+/).filter(Boolean);

  const [subcommand, aliasName, value] = parts;

  if (!subcommand || !["add", "remove", "list"].includes(subcommand)) {
    await ctx.reply(USAGE);
    return;
  }

  if (!aliasName) {
    await ctx.reply(USAGE);
    return;
  }

  const db = getDb();
  const alias = await findAliasForAllowCommand(db, aliasName);

  if (!alias) {
    await ctx.reply(`❌ Alias <code>${escapeHtml(aliasName)}</code> not found.`, {
      parse_mode: "HTML",
    });
    return;
  }

  if (!(await hasActiveHostedOrganization(db, alias.organizationId ?? null))) {
    await replyForAllowRuleLimitFailure(ctx, alias.localPart, {
      ok: false,
      code: "subscription_inactive",
    });
    return;
  }

  if (!ctx.from || !(await canManageAlias(db, ctx.api, ctx.from.id, alias.id, { fresh: true }))) {
    await ctx.reply("⛔ Access denied.");
    return;
  }

  if (subcommand === "list") {
    const rules = await listAllowRules(db, alias.id);
    if (rules.length === 0) {
      await ctx.reply(
        `📋 No allow rules for <code>${escapeHtml(aliasName)}</code>.\n\nAll mail is currently rejected.`,
        { parse_mode: "HTML" },
      );
      return;
    }
    const lines = rules.map(
      (r) => `• ${r.matchType === "domain" ? "🌐" : "📧"} ${escapeHtml(r.matchValue)}`,
    );
    await ctx.reply(
      `📋 Allow rules for <code>${escapeHtml(aliasName)}</code>:\n\n${lines.join("\n")}`,
      {
        parse_mode: "HTML",
      },
    );
    return;
  }

  if (!value) {
    await ctx.reply(USAGE);
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
    await ctx.reply(
      `✅ Removed allow rule for <code>${escapeHtml(aliasName)}</code>: ${escapeHtml(value)}`,
      {
        parse_mode: "HTML",
      },
    );
  }
}

async function findAliasForAllowCommand(
  db: ReturnType<typeof getDb>,
  aliasName: string,
): Promise<EmailAddress | null> {
  if (aliasName.includes("@")) {
    return findAliasByFullAddress(db, aliasName.toLowerCase());
  }
  return findAliasByLocalPartAnyDomain(db, aliasName);
}

export async function addAllowRuleForAlias(
  ctx: Context,
  db: ReturnType<typeof getDb>,
  alias: Pick<EmailAddress, "id" | "localPart" | "organizationId">,
  value: string,
): Promise<boolean> {
  const parsedValue = parseAllowValue(value);
  if (!parsedValue) {
    await ctx.reply(
      "❌ Invalid format. Use a domain (e.g. <code>github.com</code>) or email (e.g. <code>user@example.com</code>).",
      { parse_mode: "HTML" },
    );
    return false;
  }
  let blockedLimit: Awaited<ReturnType<typeof checkAllowRuleCreateLimit>> | null = null;
  let duplicateRule = false;

  try {
    await withOrganizationQuotaLock(db, alias.organizationId ?? null, async (tx) => {
      const existingRule = await findAllowRuleByMatch(tx, {
        emailAddressId: alias.id,
        matchType: parsedValue.matchType,
        matchValue: parsedValue.normalized,
      });
      if (existingRule) {
        duplicateRule = true;
        return;
      }

      const lockedLimit = await checkAllowRuleCreateLimit(tx, alias.organizationId ?? null);
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

  if (duplicateRule) {
    await ctx.reply(
      `ℹ️ Allow rule already exists for <code>${escapeHtml(alias.localPart)}</code>: ${parsedValue.matchType === "domain" ? "🌐" : "📧"} ${escapeHtml(parsedValue.normalized)}`,
      { parse_mode: "HTML" },
    );
    return true;
  }

  await ctx.reply(
    `✅ Added allow rule for <code>${escapeHtml(alias.localPart)}</code>: ${parsedValue.matchType === "domain" ? "🌐" : "📧"} ${escapeHtml(parsedValue.normalized)}`,
    { parse_mode: "HTML" },
  );
  return true;
}

async function replyForAllowRuleLimitFailure(
  ctx: Context,
  localPart: string,
  limit: Awaited<ReturnType<typeof checkAllowRuleCreateLimit>>,
): Promise<void> {
  if (limit.ok) return;

  if (limit.code === "subscription_inactive") {
    await ctx.reply(
      `⛔ <code>${escapeHtml(localPart)}</code> is not attached to an active hosted workspace.`,
      { parse_mode: "HTML" },
    );
    return;
  }

  if (limit.code === "allow_rule_limit") {
    const keyboard = new InlineKeyboard().text("⬆️ Upgrade Plan", CB_BILLING_UPGRADE);
    await ctx.reply(
      `📦 Plan limit reached for <code>${escapeHtml(localPart)}</code>: ${limit.used ?? limit.limit}/${limit.limit} allow rules used. Upgrade to add more.`,
      { parse_mode: "HTML", reply_markup: keyboard },
    );
    return;
  }

  await ctx.reply("❌ Allow rule creation is not available right now. Please try again later.");
}
