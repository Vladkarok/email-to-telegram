import type { CommandContext, Context } from "grammy";
import { getDb } from "../../db/client.js";
import { findAliasByLocalPart } from "../../db/repos/aliases.js";
import { addAllowRule, removeAllowRule, listAllowRules } from "../../db/repos/allowRules.js";
import { canManageAlias } from "../authorization.js";

const USAGE = `Usage:
  /allow add <alias> <email_or_domain>
  /allow remove <alias> <email_or_domain>
  /allow list <alias>

Examples:
  /allow add alerts-ab12cd github.com
  /allow add alerts-ab12cd user@example.com
  /allow list alerts-ab12cd`;

function detectMatchType(value: string): "exact_email" | "domain" {
  return value.includes("@") ? "exact_email" : "domain";
}

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
  const alias = await findAliasByLocalPart(db, aliasName);

  if (!alias) {
    await ctx.reply(`❌ Alias <code>${aliasName}</code> not found.`, { parse_mode: "HTML" });
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
        `📋 No allow rules for <code>${aliasName}</code>.\n\nAll mail is currently rejected.`,
        { parse_mode: "HTML" },
      );
      return;
    }
    const lines = rules.map((r) => `• ${r.matchType === "domain" ? "🌐" : "📧"} ${r.matchValue}`);
    await ctx.reply(`📋 Allow rules for <code>${aliasName}</code>:\n\n${lines.join("\n")}`, {
      parse_mode: "HTML",
    });
    return;
  }

  if (!value) {
    await ctx.reply(USAGE);
    return;
  }

  if (subcommand === "add") {
    const matchType = detectMatchType(value);
    await addAllowRule(db, {
      emailAddressId: alias.id,
      matchType,
      matchValue: value.toLowerCase(),
    });
    await ctx.reply(
      `✅ Added allow rule for <code>${aliasName}</code>: ${matchType === "domain" ? "🌐" : "📧"} ${value}`,
      { parse_mode: "HTML" },
    );
    return;
  }

  if (subcommand === "remove") {
    await removeAllowRule(db, {
      emailAddressId: alias.id,
      matchValue: value.toLowerCase(),
    });
    await ctx.reply(`✅ Removed allow rule for <code>${aliasName}</code>: ${value}`, {
      parse_mode: "HTML",
    });
  }
}
