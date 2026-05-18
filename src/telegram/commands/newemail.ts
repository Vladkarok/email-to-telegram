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
import { customAlphabet } from "nanoid";
import { getDb } from "../../db/client.js";
import { createAlias, listAliasesByChat } from "../../db/repos/aliases.js";
import type { EmailAddress } from "../../db/schema.js";
import { findChatById } from "../../db/repos/chats.js";
import { ensureSharedInboundDomain } from "../../db/repos/inboundDomains.js";
import { loadConfig } from "../../config.js";
import { donateHintSuffix } from "../donateHint.js";
import {
  checkAliasCreateLimit,
  hasActiveHostedUser,
  withUserQuotaLock,
} from "../../billing/limits.js";
import { getPending, clearPending, setPending } from "../session.js";
import { canManageChat } from "../authorization.js";
import { escapeHtml } from "../../utils/html.js";
import {
  HOSTED_ALIAS_CREATE_RATE_LIMIT_MESSAGE,
  HostedAliasCreateRateLimitError,
  reserveHostedAliasCreateAttempt,
} from "../../abuse/hostedAliasCreation.js";
import { DEFAULT_LOCALE, getMessages, resolveLocale, type Locale } from "../../i18n/index.js";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const generateSuffix = customAlphabet(ALPHABET, 6);

/** Validates user-supplied name before lowercasing */
const NAME_RE = /^[a-z0-9._-]{1,32}$/;

/** Maximum candidate-name attempts before giving up. */
const MAX_NAME_ATTEMPTS = 5;

/** Quick-pick allow-rule domains shown right after alias creation. */
const QUICK_ALLOW_DOMAINS = ["gmail.com", "github.com", "stripe.com"] as const;

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
    keyboard.text(`✅ ${domain}`, callback);
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

async function nextInboxName(db: ReturnType<typeof getDb>, chatId: bigint): Promise<string> {
  const aliases = await listAliasesByChat(db, chatId);
  let maxN = 0;
  let plainInboxTaken = false;
  const re = /^inbox-(\d+)$/;
  for (const a of aliases) {
    if (a.localPart === "inbox") {
      plainInboxTaken = true;
      continue;
    }
    const m = a.localPart.match(re);
    if (m && m[1]) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && n > maxN) maxN = n;
    }
  }
  if (!plainInboxTaken && maxN === 0) return "inbox";
  return `inbox-${Math.max(maxN, 1) + 1}`;
}

function isLocalPartConflict(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes("idx_alias_local_part") ||
    msg.includes("idx_alias_domain_local_part") ||
    msg.includes("duplicate key value") ||
    msg.includes("unique constraint")
  );
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
  const messages = getMessages(locale);

  if (rawName.length > 0) {
    if (rawName.length > 32) {
      await ctx.reply(messages.newemail.nameTooLong);
      return;
    }
    if (!NAME_RE.test(rawName)) {
      await ctx.reply(messages.newemail.invalidName);
      return;
    }
  }

  const db = getDb();
  const createdBy = BigInt(ctx.from.id);

  const baseName = rawName.length > 0 ? rawName : await nextInboxName(db, chatId);

  let blockedLimit: Awaited<ReturnType<typeof checkAliasCreateLimit>> | null = null;
  let alias: EmailAddress | null = null;

  for (let attempt = 0; attempt < MAX_NAME_ATTEMPTS; attempt++) {
    const candidate = attempt === 0 ? baseName : `${baseName}-${generateSuffix()}`;

    try {
      alias = await withUserQuotaLock(db, createdBy, async (tx) => {
        const inboundDomain =
          config.appMode === "hosted"
            ? await ensureSharedInboundDomain(tx, config.hostedMailDomain!)
            : null;
        const fullAddress = `${candidate}@${inboundDomain?.domain ?? config.mailDomain}`;
        const limit = await checkAliasCreateLimit(tx, createdBy);
        if (!limit.ok) {
          blockedLimit = limit;
          throw new Error("quota-blocked");
        }

        await reserveHostedAliasCreateAttempt(tx, createdBy);

        return createAlias(tx, {
          localPart: candidate,
          fullAddress,
          domainId: inboundDomain?.id ?? null,
          chatId,
          messageThreadId: threadId,
          createdBy,
          renderMode: "plaintext",
          privacyModeEnabled: false,
          bodyDedupEnabled: false,
          status: "active",
        });
      });
      break;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === "quota-blocked") {
        if (blockedLimit) await replyForAliasLimitFailure(ctx, blockedLimit);
        return;
      }
      if (err instanceof HostedAliasCreateRateLimitError) {
        await ctx.reply(HOSTED_ALIAS_CREATE_RATE_LIMIT_MESSAGE);
        return;
      }
      if (msg.includes("ensureSharedInboundDomain")) {
        await ctx.reply(messages.newemail.sharedDomainUnavailable);
        return;
      }
      if (isLocalPartConflict(err)) {
        continue;
      }
      throw err;
    }
  }

  if (!alias) {
    await ctx.reply(messages.newemail.uniqueNameFailed);
    return;
  }

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

async function replyForAliasLimitFailure(
  ctx: Context,
  limit: Awaited<ReturnType<typeof checkAliasCreateLimit>>,
): Promise<void> {
  if (limit.ok) return;

  if (limit.code === "subscription_inactive") {
    await ctx.reply(getMessages(await resolveLocale(ctx, getDb())).common.hostedAccountInactive);
    return;
  }

  if (limit.code === "alias_limit") {
    const messages = getMessages(await resolveLocale(ctx, getDb()));
    const config = loadConfig();
    const keyboard = new InlineKeyboard().text(
      messages.newemail.upgradePlanButton,
      CB_BILLING_UPGRADE,
    );
    const text =
      messages.newemail.aliasLimitReached(limit.used, limit.limit ?? 0) +
      donateHintSuffix(config, messages, "plain");
    await ctx.reply(text, { reply_markup: keyboard });
    return;
  }

  await ctx.reply(getMessages(await resolveLocale(ctx, getDb())).common.aliasCreationUnavailable);
}
