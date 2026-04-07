import { InlineKeyboard } from "grammy";
import type { Context } from "grammy";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../../db/schema.js";
import { listAliasesByChat, findAliasById } from "../../db/repos/aliases.js";
import { listAllowRules } from "../../db/repos/allowRules.js";

type Db = NodePgDatabase<typeof schema>;

function statusIcon(status: string): string {
  if (status === "active") return "✅";
  if (status === "paused") return "⏸";
  return "🗑";
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function editAliasListMenu(
  ctx: Context,
  db: Db,
  chatId: bigint,
  chatTitle: string,
): Promise<void> {
  const aliases = await listAliasesByChat(db, chatId);
  const keyboard = new InlineKeyboard();

  if (aliases.length === 0) {
    keyboard.text("📧 Create First Email", `cn:${chatId}`).row();
  } else {
    for (const alias of aliases) {
      keyboard.text(`${statusIcon(alias.status)} ${alias.localPart}`, `am:${alias.id}`).row();
    }
  }

  keyboard.text("⬅️ Back", `cm:${chatId}`);

  const header =
    aliases.length === 0
      ? `📭 <b>${escapeHtml(chatTitle)}</b>\n\nNo aliases yet.`
      : `📬 <b>${escapeHtml(chatTitle)}</b> — ${aliases.length} alias(es)\n\nTap an alias to manage it.`;

  await ctx.editMessageText(header, { parse_mode: "HTML", reply_markup: keyboard });
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

  const text =
    `📧 <code>${escapeHtml(alias.fullAddress)}</code>\n` +
    `Status: ${statusIcon(alias.status)} ${alias.status}\n` +
    `Render: <code>${alias.renderMode}</code>\n` +
    `Body dedup: <code>${alias.bodyDedupEnabled ? "on" : "off"}</code>\n\n` +
    `<b>Allow rules:</b>\n${rulesText}`;

  const keyboard = new InlineKeyboard();

  if (alias.status === "active") {
    keyboard.text("⏸ Pause", `ap:${alias.id}`);
  } else if (alias.status === "paused") {
    keyboard.text("▶️ Resume", `ar:${alias.id}`);
  }
  keyboard.text("🗑 Delete", `ad:${alias.id}`).row();
  keyboard.text("📋 Allow Rules", `al:${alias.id}`).text("⚙️ Settings", `ac:${alias.id}`).row();
  keyboard.text("⬅️ Back", `cl:${alias.chatId}`);

  await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: keyboard });
}
