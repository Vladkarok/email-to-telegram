import { InlineKeyboard } from "grammy";
import {
  CB_BILLING_UPGRADE,
  CB_ALIAS_DETAIL,
  CB_QUICK_ALLOW,
  CB_ADD_RULE,
  CB_SKIP_ALIAS,
  CB_NEW_CANCEL,
  CB_QUICK_ALLOW_RULES,
} from "../callbacks.js";
import type { CommandContext, Context } from "grammy";
import { getDb } from "../../db/client.js";
import { findChatById } from "../../db/repos/chats.js";
import { loadConfig } from "../../config.js";
import { hasActiveHostedUser, type LimitResult } from "../../billing/limits.js";
import { getPending, clearPending, setPending } from "../session.js";
import { canManageChat } from "../authorization.js";
import { escapeHtml } from "../../utils/html.js";
import { HOSTED_ALIAS_CREATE_RATE_LIMIT_MESSAGE } from "../../abuse/hostedAliasCreation.js";
import { ALIAS_IMPERSONATION_MESSAGE } from "../../abuse/aliasImpersonationGuard.js";
import { createAliasForChat, type AliasCreationResult } from "../../aliases/creation.js";
import { DEFAULT_LOCALE, getMessages, resolveLocale, type Locale } from "../../i18n/index.js";

/**
 * Quick-pick allow-rule domains shown right after alias creation. google.com
 * comes first: Gmail's forwarding confirmation is sent from it, and the
 * creation message tells users to allow it before turning forwarding on.
 */
const QUICK_ALLOW_DOMAINS = ["google.com", "github.com", "gmail.com"] as const;

export function buildQuickAllowKeyboard(
  aliasId: string,
  returnTo: "detail" | "rules" = "detail",
  locale: Locale = DEFAULT_LOCALE,
): InlineKeyboard {
  const messages = getMessages(locale);
  const keyboard = new InlineKeyboard();
  for (const domain of QUICK_ALLOW_DOMAINS) {
    const callback =
      returnTo === "rules"
        ? CB_QUICK_ALLOW_RULES.build(aliasId, domain)
        : CB_QUICK_ALLOW.build(aliasId, domain);
    keyboard.text(`🔐 ${domain}`, callback);
  }
  keyboard.row().text(messages.newemail.customDomainButton, CB_ADD_RULE.build(aliasId));
  return keyboard;
}

export function appendAliasManageButton(
  keyboard: InlineKeyboard,
  aliasId: string,
  locale: Locale = DEFAULT_LOCALE,
): InlineKeyboard {
  return keyboard
    .row()
    .text(getMessages(locale).newemail.manageAliasButton, CB_ALIAS_DETAIL.build(aliasId));
}

export async function promptForEmailAliasName(
  ctx: Context,
  chatId: bigint,
  chatTitle: string,
  messageThreadId: bigint | null,
  mode: "reply" | "edit",
): Promise<void> {
  if (!ctx.from) return;
  const messages = getMessages(await resolveLocale(ctx, getDb()));

  setPending(ctx.from.id, { action: "newemail", chatId, chatTitle, messageThreadId });

  const keyboard = new InlineKeyboard()
    .text(messages.newemail.autoNameButton, CB_SKIP_ALIAS.build(chatId))
    .row()
    .text(messages.newemail.cancelButton, CB_NEW_CANCEL);

  const text = messages.newemail.prompt(escapeHtml(chatTitle));

  if (mode === "edit") {
    await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: keyboard });
    return;
  }

  await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
}

export async function newemailHandler(ctx: CommandContext<Context>): Promise<void> {
  if (!ctx.from) return;

  const rawName = ctx.match.trim();
  const db = getDb();
  const acting = BigInt(ctx.from.id);

  // Determine target chat: session context (DM flow) > current chat
  const pending = getPending(ctx.from.id);
  let targetChatId: bigint;
  let targetThreadId: bigint | null = null;
  let targetChatTitle: string | undefined;

  if (pending?.action === "newemail") {
    targetChatId = pending.chatId;
    targetChatTitle = pending.chatTitle;
  } else {
    targetChatId = BigInt(ctx.chat.id);
    targetThreadId =
      ctx.message?.message_thread_id != null ? BigInt(ctx.message.message_thread_id) : null;
    const chat = await findChatById(db, targetChatId);
    targetChatTitle = chat?.title;
  }

  if (rawName.length === 0 && !pending) {
    const messages = getMessages(await resolveLocale(ctx, db));
    if (!(await hasActiveHostedUser(db, acting))) {
      await replyForAliasLimitFailure(ctx, { ok: false, code: "subscription_inactive" });
      return;
    }

    if (!(await canManageChat(ctx.api, ctx.from.id, targetChatId, { fresh: true }))) {
      await ctx.reply(messages.common.accessDenied);
      return;
    }

    await promptForEmailAliasName(
      ctx,
      targetChatId,
      targetChatTitle ?? "this chat",
      targetThreadId,
      "reply",
    );
    return;
  }

  if (!(await hasActiveHostedUser(db, acting))) {
    clearPending(ctx.from.id);
    await replyForAliasLimitFailure(ctx, { ok: false, code: "subscription_inactive" });
    return;
  }

  if (!(await canManageChat(ctx.api, ctx.from.id, targetChatId, { fresh: true }))) {
    clearPending(ctx.from.id);
    await ctx.reply(getMessages(await resolveLocale(ctx, db)).common.accessDenied);
    return;
  }

  clearPending(ctx.from.id);

  await createEmailAlias(ctx, rawName, targetChatId, targetThreadId, targetChatTitle);
}

export async function createEmailAlias(
  ctx: Context,
  rawName: string,
  chatId: bigint,
  threadId: bigint | null,
  chatTitle: string | undefined,
): Promise<void> {
  if (!ctx.from) return;
  const config = loadConfig();
  const locale = await resolveLocale(ctx, getDb());

  const result = await createAliasForChat(
    getDb(),
    {
      createdBy: BigInt(ctx.from.id),
      chatId,
      threadId,
      requestedName: rawName.length > 0 ? rawName : null,
    },
    config,
  );
  await replyForAliasCreation(ctx, result, chatTitle, locale);
}

/** The reply for each creation outcome. Exported for the reply-mapping tests. */
export async function replyForAliasCreation(
  ctx: Context,
  result: AliasCreationResult,
  chatTitle: string | undefined,
  locale: Locale,
): Promise<void> {
  const messages = getMessages(locale);
  switch (result.kind) {
    case "name_too_long":
      await ctx.reply(messages.newemail.nameTooLong);
      return;
    case "invalid_name":
      await ctx.reply(messages.newemail.invalidName);
      return;
    case "impersonation":
      await ctx.reply(ALIAS_IMPERSONATION_MESSAGE);
      return;
    case "name_cooldown":
      await ctx.reply(messages.newemail.nameCooldown);
      return;
    case "limit":
      await replyForAliasLimitFailure(ctx, result.limit);
      return;
    case "chat_migrated":
      await ctx.reply(messages.newemail.chatUnavailable);
      return;
    case "rate_limited":
      await ctx.reply(HOSTED_ALIAS_CREATE_RATE_LIMIT_MESSAGE);
      return;
    case "domain_unavailable":
      await ctx.reply(messages.newemail.sharedDomainUnavailable);
      return;
    case "name_taken":
      await ctx.reply(messages.newemail.nameTaken);
      return;
    case "no_unique_name":
      await ctx.reply(messages.newemail.uniqueNameFailed);
      return;
    case "created":
      break;
  }

  const alias = result.alias;
  const chatNote = chatTitle ? messages.newemail.deliveringTo(escapeHtml(chatTitle)) : "";
  const fullAddress = alias.fullAddress;

  const keyboard = appendAliasManageButton(
    buildQuickAllowKeyboard(alias.id, "detail", locale),
    alias.id,
    locale,
  );

  await ctx.reply(messages.newemail.created(fullAddress, chatNote), {
    parse_mode: "HTML",
    reply_markup: keyboard,
  });
}

async function replyForAliasLimitFailure(ctx: Context, limit: LimitResult): Promise<void> {
  if (limit.ok) return;

  if (limit.code === "subscription_inactive") {
    await ctx.reply(getMessages(await resolveLocale(ctx, getDb())).common.hostedAccountInactive);
    return;
  }

  if (limit.code === "alias_limit") {
    const messages = getMessages(await resolveLocale(ctx, getDb()));
    const keyboard = new InlineKeyboard().text(
      messages.newemail.upgradePlanButton,
      CB_BILLING_UPGRADE,
    );
    const text = messages.newemail.aliasLimitReached(limit.used, limit.limit ?? 0);
    await ctx.reply(text, { reply_markup: keyboard });
    return;
  }

  await ctx.reply(getMessages(await resolveLocale(ctx, getDb())).common.aliasCreationUnavailable);
}
