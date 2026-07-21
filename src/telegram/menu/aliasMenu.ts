import { InlineKeyboard } from "grammy";
import type { Context } from "grammy";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../../db/schema.js";
import type { EmailAddress } from "../../db/schema.js";
import { listAliasesByChat, findAliasById } from "../../db/repos/aliases.js";
import { listAllowRules } from "../../db/repos/allowRules.js";
import { canManageAlias } from "../authorization.js";
import { escapeHtml } from "../../utils/html.js";
import { getMessages, resolveLocale } from "../../i18n/index.js";
import { allowRuleIcon } from "../allowRuleDisplay.js";
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
  CB_ALIAS_MOVE,
  CB_ALIAS_SET_TOPIC,
} from "../callbacks.js";

type Db = NodePgDatabase<typeof schema>;

function statusIcon(status: string): string {
  if (status === "active") return "✅";
  if (status === "paused") return "⏸";
  return "🗑";
}

function statusText(status: string, messages: ReturnType<typeof getMessages>): string {
  if (status === "active") return messages.aliasMenu.statusActive;
  if (status === "paused") return messages.aliasMenu.statusPaused;
  return messages.aliasMenu.statusDeleted;
}

export async function editAliasListMenu(
  ctx: Context,
  db: Db,
  chatId: bigint,
  chatTitle: string,
): Promise<void> {
  const messages = getMessages(await resolveLocale(ctx, db));
  const aliases = await filterVisibleAliases(ctx, db, await listAliasesByChat(db, chatId));
  const keyboard = new InlineKeyboard();

  if (aliases.length === 0) {
    keyboard.text(messages.aliasMenu.createFirstButton, CB_NEW_EMAIL.build(chatId)).row();
  } else {
    for (const alias of aliases) {
      const buttonLabel = alias.label
        ? `${statusIcon(alias.status)} ${alias.label}`
        : `${statusIcon(alias.status)} ${alias.localPart}`;
      keyboard.text(buttonLabel, CB_ALIAS_DETAIL.build(alias.id)).row();
    }
  }

  keyboard.text(messages.aliasMenu.backButton, CB_CHAT_MENU.build(chatId));

  const header =
    aliases.length === 0
      ? messages.aliasMenu.emptyHeader(escapeHtml(chatTitle))
      : messages.aliasMenu.listHeader(escapeHtml(chatTitle), aliases.length);

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
  const detail = await buildAliasDetailMenu(ctx, db, aliasId, "callback");
  if (!detail) return;

  await ctx.editMessageText(detail.text, { parse_mode: "HTML", reply_markup: detail.keyboard });
}

export async function sendAliasDetailMenu(ctx: Context, db: Db, aliasId: string): Promise<void> {
  const detail = await buildAliasDetailMenu(ctx, db, aliasId, "reply");
  if (!detail) return;

  await ctx.reply(detail.text, { parse_mode: "HTML", reply_markup: detail.keyboard });
}

async function buildAliasDetailMenu(
  ctx: Context,
  db: Db,
  aliasId: string,
  missingMode: "callback" | "reply",
): Promise<{ text: string; keyboard: InlineKeyboard } | null> {
  const messages = getMessages(await resolveLocale(ctx, db));
  const alias = await findAliasById(db, aliasId);
  if (!alias) {
    if (missingMode === "callback") {
      await ctx.answerCallbackQuery(messages.common.aliasNotFoundShort);
    } else {
      await ctx.reply(messages.common.aliasNotFound);
    }
    return null;
  }

  const rules = await listAllowRules(db, alias.id);
  const rulesText =
    rules.length > 0
      ? rules.map((r) => `• ${allowRuleIcon()} ${escapeHtml(r.matchValue)}`).join("\n")
      : messages.aliasMenu.allowRulesEmpty;

  const text = messages.aliasMenu.detailLines({
    label: alias.label ? escapeHtml(alias.label) : null,
    address: escapeHtml(alias.fullAddress),
    statusIcon: statusIcon(alias.status),
    statusText: statusText(alias.status, messages),
    renderMode: alias.renderMode,
    privacyOn: alias.privacyModeEnabled,
    bodyDedupOn: alias.bodyDedupEnabled,
    rulesText,
  });

  const keyboard = new InlineKeyboard();

  if (alias.status === "active") {
    keyboard.text(messages.aliasMenu.pauseButton, CB_ALIAS_PAUSE.build(alias.id));
  } else if (alias.status === "paused") {
    keyboard.text(messages.aliasMenu.resumeButton, CB_ALIAS_RESUME.build(alias.id));
  }
  keyboard.text(messages.aliasMenu.deleteButton, CB_ALIAS_DELETE.build(alias.id)).row();
  keyboard
    .text(messages.aliasMenu.allowRulesButton, CB_ALLOW_RULES.build(alias.id))
    .text(messages.aliasMenu.settingsButton, CB_ALIAS_SETTINGS.build(alias.id))
    .row();
  keyboard.text(messages.aliasMenu.moveButton, CB_ALIAS_MOVE.build(alias.id)).row();
  // Only meaningful when this menu was opened inside a forum topic: the
  // callback message's thread is the topic the user is pointing at.
  const currentThreadId = ctx.callbackQuery?.message?.message_thread_id ?? null;
  if (
    currentThreadId !== null &&
    (alias.messageThreadId === null || BigInt(currentThreadId) !== alias.messageThreadId)
  ) {
    keyboard
      .text(
        messages.aliasMenu.topicButton,
        CB_ALIAS_SET_TOPIC.build(alias.id, alias.routingVersion),
      )
      .row();
  }
  if (alias.label) {
    keyboard
      .text(messages.aliasMenu.editLabelButton, CB_ALIAS_LABEL_EDIT.build(alias.id))
      .text(messages.aliasMenu.clearLabelButton, CB_ALIAS_LABEL_CLEAR.build(alias.id))
      .row();
  } else {
    keyboard.text(messages.aliasMenu.setLabelButton, CB_ALIAS_LABEL_EDIT.build(alias.id)).row();
  }
  keyboard.text(messages.aliasMenu.backButton, CB_ALIAS_LIST.build(alias.chatId));

  return { text, keyboard };
}

export async function editAliasDeleteConfirmMenu(
  ctx: Context,
  db: Db,
  aliasId: string,
): Promise<void> {
  const messages = getMessages(await resolveLocale(ctx, db));
  const alias = await findAliasById(db, aliasId);
  if (!alias) {
    await ctx.answerCallbackQuery(messages.common.aliasNotFoundShort);
    return;
  }

  const keyboard = new InlineKeyboard()
    .text(
      messages.aliasMenu.deleteConfirmYes,
      // Bind the confirmation to the routing state the user is looking at.
      CB_ALIAS_DELETE_CONFIRM.build(alias.id, alias.routingVersion),
    )
    .row()
    .text(messages.aliasMenu.deleteConfirmCancel, CB_ALIAS_DELETE_CANCEL.build(alias.id));

  const text = messages.aliasMenu.deleteConfirmHeader(escapeHtml(alias.fullAddress));

  await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: keyboard });
}
