import { InlineKeyboard } from "grammy";
import type { Context } from "grammy";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../../db/schema.js";
import { findAliasById } from "../../db/repos/aliases.js";
import { listAllowRules } from "../../db/repos/allowRules.js";
import { escapeHtml } from "../../utils/html.js";
import { getMessages, resolveLocale, type Locale } from "../../i18n/index.js";
import { CB_DELETE_RULE, CB_ADD_RULE, CB_ALIAS_DETAIL } from "../callbacks.js";

type Db = NodePgDatabase<typeof schema>;

function buildAllowRulesKeyboard(
  rules: { id: string; matchType: string; matchValue: string }[],
  aliasId: string,
  locale: Locale,
): InlineKeyboard {
  const messages = getMessages(locale);
  const keyboard = new InlineKeyboard();
  for (const rule of rules) {
    const icon = rule.matchType === "domain" ? "🌐" : "📧";
    keyboard.text(`❌ ${icon} ${rule.matchValue}`, CB_DELETE_RULE.build(rule.id)).row();
  }
  keyboard.text(messages.allowRulesMenu.addRuleButton, CB_ADD_RULE.build(aliasId)).row();
  keyboard.text(messages.allowRulesMenu.backButton, CB_ALIAS_DETAIL.build(aliasId));
  return keyboard;
}

function buildHeader(localPart: string, ruleCount: number, locale: Locale): string {
  const messages = getMessages(locale);
  if (ruleCount === 0) {
    return messages.allowRulesMenu.headerEmpty(escapeHtml(localPart));
  }
  return messages.allowRulesMenu.headerWithRules(escapeHtml(localPart), ruleCount);
}

export async function sendAllowRulesMenu(ctx: Context, db: Db, aliasId: string): Promise<void> {
  const alias = await findAliasById(db, aliasId);
  if (!alias) return;
  const locale = await resolveLocale(ctx, db);
  const rules = await listAllowRules(db, aliasId);
  const keyboard = buildAllowRulesKeyboard(rules, aliasId, locale);
  await ctx.reply(buildHeader(alias.localPart, rules.length, locale), {
    parse_mode: "HTML",
    reply_markup: keyboard,
  });
}

export async function editAllowRulesMenu(ctx: Context, db: Db, aliasId: string): Promise<void> {
  const locale = await resolveLocale(ctx, db);
  const messages = getMessages(locale);
  const alias = await findAliasById(db, aliasId);
  if (!alias) {
    await ctx.answerCallbackQuery?.(messages.common.aliasNotFoundShort);
    return;
  }
  const rules = await listAllowRules(db, aliasId);
  const keyboard = buildAllowRulesKeyboard(rules, aliasId, locale);
  await ctx.editMessageText(buildHeader(alias.localPart, rules.length, locale), {
    parse_mode: "HTML",
    reply_markup: keyboard,
  });
}
