import { InlineKeyboard } from "grammy";
import type { Context } from "grammy";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../../db/schema.js";
import { findAliasById } from "../../db/repos/aliases.js";
import { listAllowRules } from "../../db/repos/allowRules.js";
import { escapeHtml } from "../../utils/html.js";

type Db = NodePgDatabase<typeof schema>;


function buildAllowRulesKeyboard(
  rules: { id: string; matchType: string; matchValue: string }[],
  aliasId: string,
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const rule of rules) {
    const icon = rule.matchType === "domain" ? "🌐" : "📧";
    keyboard.text(`❌ ${icon} ${rule.matchValue}`, `dr:${rule.id}`).row();
  }
  keyboard.text("➕ Add Rule", `aa:${aliasId}`).row();
  keyboard.text("⬅️ Back", `am:${aliasId}`);
  return keyboard;
}

function buildHeader(localPart: string, ruleCount: number): string {
  if (ruleCount === 0) {
    return (
      `📋 <b>${escapeHtml(localPart)}</b> — Allow Rules\n\n` +
      `⚠️ No rules — all mail is rejected.\n\n` +
      `Add at least one domain or email to start receiving mail.`
    );
  }
  return `📋 <b>${escapeHtml(localPart)}</b> — ${ruleCount} allow rule(s)\n\nTap ❌ to remove a rule.`;
}

export async function sendAllowRulesMenu(ctx: Context, db: Db, aliasId: string): Promise<void> {
  const alias = await findAliasById(db, aliasId);
  if (!alias) return;
  const rules = await listAllowRules(db, aliasId);
  const keyboard = buildAllowRulesKeyboard(rules, aliasId);
  await ctx.reply(buildHeader(alias.localPart, rules.length), {
    parse_mode: "HTML",
    reply_markup: keyboard,
  });
}

export async function editAllowRulesMenu(ctx: Context, db: Db, aliasId: string): Promise<void> {
  const alias = await findAliasById(db, aliasId);
  if (!alias) {
    await ctx.answerCallbackQuery?.("Alias not found.");
    return;
  }
  const rules = await listAllowRules(db, aliasId);
  const keyboard = buildAllowRulesKeyboard(rules, aliasId);
  await ctx.editMessageText(buildHeader(alias.localPart, rules.length), {
    parse_mode: "HTML",
    reply_markup: keyboard,
  });
}
