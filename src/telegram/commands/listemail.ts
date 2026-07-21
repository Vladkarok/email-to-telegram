import { InlineKeyboard } from "grammy";
import type { Context } from "grammy";
import { getDb } from "../../db/client.js";
import { listAliasesByChat, findAliasesByCreator } from "../../db/repos/aliases.js";
import { findChatById } from "../../db/repos/chats.js";
import type { EmailAddress } from "../../db/schema.js";
import { canManageAlias, canManageChat } from "../authorization.js";
import { listRecoverableOrphans } from "../orphanRecovery.js";
import { escapeHtml } from "../../utils/html.js";
import { CB_ALIAS_DETAIL, CB_ALIAS_ORPHAN } from "../callbacks.js";
import { getMessages, resolveLocale } from "../../i18n/index.js";

export async function listemailHandler(ctx: Context): Promise<void> {
  if (!ctx.from || !ctx.chat) return;

  if (ctx.chat.type === "private") {
    await listAllChats(ctx);
  } else {
    await listForCurrentChat(ctx);
  }
}

async function listForCurrentChat(ctx: Context): Promise<void> {
  if (!ctx.from) return;
  const chatId = BigInt(ctx.chat!.id);
  const db = getDb();
  const locale = await resolveLocale(ctx, db);
  const messages = getMessages(locale);

  if (!(await canManageChat(ctx.api, ctx.from.id, chatId, { fresh: true }))) {
    await ctx.reply(messages.common.accessDenied);
    return;
  }

  const aliases = await filterVisibleAliases(ctx, db, await listAliasesByChat(db, chatId));

  if (aliases.length === 0) {
    await ctx.reply(messages.listemail.noAliasesForChat);
    return;
  }

  const lines = aliases.map((a) => displayLine(a));
  const keyboard = buildAliasButtons(aliases);
  await ctx.reply(
    `${messages.listemail.aliasesForChat(aliases.length)}\n\n${lines.join("\n")}\n\n${messages.listemail.manageHint}`,
    { parse_mode: "HTML", reply_markup: keyboard },
  );
}

async function listAllChats(ctx: Context): Promise<void> {
  const db = getDb();
  const locale = await resolveLocale(ctx, db);
  const messages = getMessages(locale);
  const aliases = await findAliasesByCreator(db, BigInt(ctx.from!.id));
  const visibleAliases = await filterVisibleAliases(ctx, db, aliases);

  // Aliases whose chat is definitively dead are invisible to canManageAlias
  // (the membership check errors out), so they are listed separately with
  // exactly two recovery actions. Only the creator sees them.
  //
  // An orphan is by construction an alias that filterVisibleAliases already
  // rejected, so only those are worth probing — probing the visible ones too
  // would cost a getChatMember round-trip per live chat on every /listemail.
  const visibleIds = new Set(visibleAliases.map((alias) => alias.id));
  const orphanCandidates = aliases.filter((alias) => !visibleIds.has(alias.id));
  const orphans =
    orphanCandidates.length === 0
      ? []
      : await listRecoverableOrphans(db, ctx.api, ctx.from!.id, orphanCandidates);

  if (visibleAliases.length === 0 && orphans.length === 0) {
    await ctx.reply(messages.listemail.noAliases);
    return;
  }

  if (visibleAliases.length === 0) {
    await ctx.reply(renderOrphanSection(orphans, messages), {
      parse_mode: "HTML",
      reply_markup: buildOrphanButtons(orphans, messages),
    });
    return;
  }

  // Group by chat for the message body header; the keyboard stays flat.
  const byChatId = new Map<string, EmailAddress[]>();
  for (const alias of visibleAliases) {
    const key = alias.chatId.toString();
    const group = byChatId.get(key) ?? [];
    group.push(alias);
    byChatId.set(key, group);
  }

  const sections: string[] = [];
  for (const [chatIdStr, chatAliases] of byChatId) {
    const chat = await findChatById(db, BigInt(chatIdStr));
    const chatLabel = chat ? escapeHtml(chat.title) : `Chat ${chatIdStr}`;
    const lines = chatAliases.map((a) => `  ${displayLine(a)}`);
    sections.push(`<b>${chatLabel}</b>\n${lines.join("\n")}`);
  }

  const keyboard = buildAliasButtons(visibleAliases);
  if (orphans.length > 0) {
    sections.push(renderOrphanSection(orphans, messages));
    for (const orphan of orphans) {
      keyboard
        .text(messages.listemail.orphanButton(orphan.localPart), CB_ALIAS_ORPHAN.build(orphan.id))
        .row();
    }
  }

  await ctx.reply(
    `${messages.listemail.allAliases(visibleAliases.length)}\n\n${sections.join("\n\n")}\n\n${messages.listemail.manageHint}`,
    { parse_mode: "HTML", reply_markup: keyboard },
  );
}

function renderOrphanSection(
  orphans: EmailAddress[],
  messages: ReturnType<typeof getMessages>,
): string {
  const lines = orphans.map((a) => `  ⚠️ <code>${escapeHtml(a.fullAddress)}</code>`);
  return `${messages.listemail.orphanHeader}\n${lines.join("\n")}\n\n${messages.listemail.orphanHint}`;
}

function buildOrphanButtons(
  orphans: EmailAddress[],
  messages: ReturnType<typeof getMessages>,
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const orphan of orphans) {
    keyboard
      .text(messages.listemail.orphanButton(orphan.localPart), CB_ALIAS_ORPHAN.build(orphan.id))
      .row();
  }
  return keyboard;
}

function statusIcon(status: string): string {
  if (status === "active") return "✅";
  if (status === "paused") return "⏸";
  return "🗑";
}

/**
 * Renders a single alias as a text line for the message body.
 *
 * Hides the render mode tag when it's the default ("plaintext") to reduce noise.
 * Shows the optional label when set.
 */
function displayLine(a: EmailAddress): string {
  const labelPrefix = a.label ? `🏷️ ${escapeHtml(a.label)} · ` : "";
  const modeSuffix = a.renderMode === "plaintext" ? "" : ` [${a.renderMode}]`;
  return `${statusIcon(a.status)} ${labelPrefix}<code>${escapeHtml(a.fullAddress)}</code>${modeSuffix}`;
}

/**
 * Builds an inline keyboard with one button per alias.
 *
 * Button text uses the label if set, otherwise the local part.
 */
function buildAliasButtons(aliases: EmailAddress[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const alias of aliases) {
    const buttonLabel = alias.label
      ? `${statusIcon(alias.status)} ${alias.label}`
      : `${statusIcon(alias.status)} ${alias.localPart}`;
    keyboard.text(buttonLabel, CB_ALIAS_DETAIL.build(alias.id)).row();
  }
  return keyboard;
}

async function filterVisibleAliases(
  ctx: Context,
  db: ReturnType<typeof getDb>,
  aliases: EmailAddress[],
) {
  if (!ctx.from) return [];
  const checked = await Promise.all(
    aliases.map(async (alias) => ({
      alias,
      allowed: await canManageAlias(db, ctx.api, ctx.from!.id, alias.id),
    })),
  );
  return checked.filter(({ allowed }) => allowed).map(({ alias }) => alias);
}
