import { InlineKeyboard } from "grammy";
import type { Context } from "grammy";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../../db/schema.js";
import type { EmailAddress } from "../../db/schema.js";
import { listAliasesByChat, findAliasById } from "../../db/repos/aliases.js";
import { listAllowRules } from "../../db/repos/allowRules.js";
import { canManageAlias } from "../authorization.js";
import { escapeHtml } from "../../utils/html.js";
import {
  CB_NEW_EMAIL,
  CB_ALIAS_DETAIL,
  CB_CHAT_MENU,
  CB_ALIAS_PAUSE,
  CB_ALIAS_RESUME,
  CB_ALIAS_DELETE,
  CB_ALIAS_DELETE_CANCEL,
  CB_ALIAS_DELETE_CONFIRM,
  CB_ALLOW_RULES,
  CB_ALIAS_SETTINGS,
  CB_ALIAS_LIST,
  CB_ALIAS_LABEL_EDIT,
  CB_ALIAS_LABEL_CLEAR,
} from "../callbacks.js";

type Db = NodePgDatabase<typeof schema>;

function statusIcon(status: string): string {
  if (status === "active") return "✅";
  if (status === "paused") return "⏸";
  return "🗑";
}

export async function editAliasListMenu(
  ctx: Context,
  db: Db,
  chatId: bigint,
  chatTitle: string,
): Promise<void> {
  const aliases = await filterVisibleAliases(ctx, db, await listAliasesByChat(db, chatId));
  const keyboard = new InlineKeyboard();

  if (aliases.length === 0) {
    keyboard.text("📧 Create First Email", CB_NEW_EMAIL.build(chatId)).row();
  } else {
    for (const alias of aliases) {
      const buttonLabel = alias.label
        ? `${statusIcon(alias.status)} ${alias.label}`
        : `${statusIcon(alias.status)} ${alias.localPart}`;
      keyboard.text(buttonLabel, CB_ALIAS_DETAIL.build(alias.id)).row();
    }
  }

  keyboard.text("⬅️ Back", CB_CHAT_MENU.build(chatId));

  const header =
    aliases.length === 0
      ? `📭 <b>${escapeHtml(chatTitle)}</b>\n\nNo aliases yet.`
      : `📬 <b>${escapeHtml(chatTitle)}</b> — ${aliases.length} alias(es)\n\nTap an alias to manage it.`;

  await ctx.editMessageText(header, { parse_mode: "HTML", reply_markup: keyboard });
}

async function filterVisibleAliases(ctx: Context, db: Db, aliases: EmailAddress[]) {
  if (!ctx.from) return [];
  const checked = await Promise.all(
    aliases.map(async (alias) => ({
      alias,
      allowed: await canManageAlias(db, ctx.api, ctx.from!.id, alias.id),
    })),
  );
  return checked.filter(({ allowed }) => allowed).map(({ alias }) => alias);
}

export async function editAliasDetailMenu(ctx: Context, db: Db, aliasId: string): Promise<void> {
  const alias = await findAliasById(db, aliasId);
  if (!alias) {
    await ctx.answerCallbackQuery("Alias not found.");
    return;
  }

  const rules = await listAllowRules(db, alias.id);
  const rulesText =
    rules.length > 0
      ? rules
          .map((r) => `• ${r.matchType === "domain" ? "🌐" : "📧"} ${escapeHtml(r.matchValue)}`)
          .join("\n")
      : "⚠️ None — all mail rejected";

  const labelLine = alias.label ? `🏷️ <b>${escapeHtml(alias.label)}</b>\n` : "";

  const text =
    labelLine +
    `📧 <code>${escapeHtml(alias.fullAddress)}</code>\n` +
    `Status: ${statusIcon(alias.status)} ${alias.status}\n` +
    `Render: <code>${alias.renderMode}</code>\n` +
    `Privacy mode: <code>${alias.privacyModeEnabled ? "on" : "off"}</code>\n` +
    `Body dedup: <code>${alias.bodyDedupEnabled ? "on" : "off"}</code>\n\n` +
    `<b>Allow rules:</b>\n${rulesText}`;

  const keyboard = new InlineKeyboard();

  if (alias.status === "active") {
    keyboard.text("⏸ Pause", CB_ALIAS_PAUSE.build(alias.id));
  } else if (alias.status === "paused") {
    keyboard.text("▶️ Resume", CB_ALIAS_RESUME.build(alias.id));
  }
  keyboard.text("🗑 Delete", CB_ALIAS_DELETE.build(alias.id)).row();
  keyboard
    .text("📋 Allow Rules", CB_ALLOW_RULES.build(alias.id))
    .text("⚙️ Settings", CB_ALIAS_SETTINGS.build(alias.id))
    .row();
  if (alias.label) {
    keyboard
      .text("✏️ Edit Label", CB_ALIAS_LABEL_EDIT.build(alias.id))
      .text("🧹 Clear Label", CB_ALIAS_LABEL_CLEAR.build(alias.id))
      .row();
  } else {
    keyboard.text("🏷️ Set Label", CB_ALIAS_LABEL_EDIT.build(alias.id)).row();
  }
  keyboard.text("⬅️ Back", CB_ALIAS_LIST.build(alias.chatId));

  await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: keyboard });
}

export async function editAliasDeleteConfirmMenu(
  ctx: Context,
  db: Db,
  aliasId: string,
): Promise<void> {
  const alias = await findAliasById(db, aliasId);
  if (!alias) {
    await ctx.answerCallbackQuery("Alias not found.");
    return;
  }

  const keyboard = new InlineKeyboard()
    .text("🗑 Yes, delete", CB_ALIAS_DELETE_CONFIRM.build(alias.id))
    .row()
    .text("⬅️ Keep alias", CB_ALIAS_DELETE_CANCEL.build(alias.id));

  const text =
    `⚠️ Delete this email alias?\n\n` +
    `📧 <code>${escapeHtml(alias.fullAddress)}</code>\n\n` +
    `Future emails sent to this address will be rejected.`;

  await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: keyboard });
}
