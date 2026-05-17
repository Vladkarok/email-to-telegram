import { Bot, type Context, type NextFunction } from "grammy";
import { getDb } from "../db/client.js";
import { authMiddleware } from "./middleware/auth.js";
import {
  assertChatAccess,
  assertAliasAccess,
  assertHostedChatWorkspaceReady,
  assertHostedAliasWorkspaceReady,
} from "./middleware/authorization.js";
import { startHandler } from "./commands/start.js";
import {
  newemailHandler,
  createEmailAlias,
  promptForEmailAliasName,
  buildQuickAllowKeyboard,
} from "./commands/newemail.js";
import { listemailHandler } from "./commands/listemail.js";
import { deleteemailHandler } from "./commands/deleteemail.js";
import { pauseemailHandler } from "./commands/pauseemail.js";
import { resumeemailHandler } from "./commands/resumeemail.js";
import {
  settingsHandler,
  buildAliasSettingsKeyboard,
  buildAliasSettingsText,
} from "./commands/settings.js";
import { addAllowRuleForAlias, allowHandler } from "./commands/allow.js";
import { helpHandler } from "./commands/help.js";
import {
  languageCallbackHandler,
  languageCloseCallbackHandler,
  languageHandler,
} from "./commands/language.js";
import { planHandler } from "./commands/plan.js";
import { usageHandler } from "./commands/usage.js";
import { billingHandler } from "./commands/billing.js";
import { donateHandler } from "./commands/donate.js";
import {
  upgradeHandler,
  upgradeCallbackHandler,
  upgradePlanCallbackHandler,
} from "./commands/upgrade.js";
import {
  CB_CHAT_SELECTION,
  CB_NEW_CANCEL,
  CB_BILLING_UPGRADE,
  CB_BILLING_PORTAL,
  CB_CHAT_MENU,
  CB_ALIAS_LIST,
  CB_NEW_EMAIL,
  CB_SKIP_ALIAS,
  CB_ALIAS_DETAIL,
  CB_ALIAS_PAUSE,
  CB_ALIAS_RESUME,
  CB_ALIAS_DELETE,
  CB_ALIAS_DELETE_CANCEL,
  CB_ALIAS_DELETE_CONFIRM,
  CB_ALIAS_SETTINGS,
  CB_SET_MODE,
  CB_TOGGLE_BODY_DEDUP,
  CB_TOGGLE_PRIVACY_MODE,
  CB_ALLOW_RULES,
  CB_DELETE_RULE,
  CB_ADD_RULE,
  CB_CANCEL_ADD_RULE,
  CB_UPGRADE_PLAN,
  CB_QUICK_ALLOW,
  CB_QUICK_ALLOW_RULES,
  CB_ALIAS_LABEL_EDIT,
  CB_ALIAS_LABEL_CLEAR,
  CB_ALIAS_LABEL_CANCEL,
  CB_LANGUAGE_SET,
  CB_LANGUAGE_CLOSE,
} from "./callbacks.js";
import { portalHandler, portalCallbackHandler } from "./commands/portal.js";
import { chatMemberHandler } from "./handlers/chatMember.js";
import { editChatSelectionMenu, editChatManagementMenu } from "./menu/chatMenu.js";
import {
  editAliasListMenu,
  editAliasDetailMenu,
  sendAliasDetailMenu,
  editAliasDeleteConfirmMenu,
} from "./menu/aliasMenu.js";
import { sendAllowRulesMenu, editAllowRulesMenu } from "./menu/allowRulesMenu.js";
import {
  findAliasById,
  updateAliasBodyDedup,
  updateAliasLabel,
  updateAliasPrivacyMode,
  updateAliasStatus,
  updateAliasRenderMode,
} from "../db/repos/aliases.js";
import { findChatById } from "../db/repos/chats.js";
import { findAllowRuleById, removeAllowRule } from "../db/repos/allowRules.js";
import { getPending, clearPending, setPending } from "./session.js";
import { canManageChat, canManageAlias } from "./authorization.js";
import { aliasResolutionError, resolveManageableAlias } from "./aliasResolver.js";
import { parseAllowValue } from "./allowValue.js";
import { getLogger } from "../utils/logger.js";
import { InlineKeyboard } from "grammy";
import { hasActiveHostedOrganization } from "../billing/limits.js";
import { escapeHtml } from "../utils/html.js";
import { DEFAULT_LOCALE, SUPPORTED_LOCALES, getMessages, resolveLocale } from "../i18n/index.js";

export {
  assertHostedChatWorkspaceReady,
  assertHostedAliasWorkspaceReady,
} from "./middleware/authorization.js";

export function createBot(token: string): Bot {
  const bot = new Bot(token);
  const logger = getLogger();

  // Global error handler
  bot.catch((err) => {
    logger.error({ err: err.error, update: err.ctx.update }, "Bot error");
  });

  // ── Auto-register groups ────────────────────────────────────────────────────
  bot.on("my_chat_member", chatMemberHandler);

  // ── /start is exempt from auth ──────────────────────────────────────────────
  bot.command("start", startHandler);

  // ── Auth middleware ─────────────────────────────────────────────────────────
  bot.use(authMiddleware);

  // ── Pending action handler (text replies during multi-step flows) ───────────
  bot.on("message:text", handlePendingTextMessage);

  // ── Commands ────────────────────────────────────────────────────────────────
  bot.command("newemail", newemailHandler);
  bot.command("listemail", listemailHandler);
  bot.command("deleteemail", deleteemailHandler);
  bot.command("pauseemail", pauseemailHandler);
  bot.command("resumeemail", resumeemailHandler);
  bot.command("settings", settingsHandler);
  bot.command("allow", allowHandler);
  bot.command("label", labelHandler);
  bot.command("help", helpHandler);
  bot.command("language", languageHandler);
  bot.command("plan", planHandler);
  bot.command("usage", usageHandler);
  bot.command("billing", billingHandler);
  bot.command("upgrade", upgradeHandler);
  bot.command("portal", portalHandler);
  bot.command("donate", donateHandler);

  // bill:upgrade / bill:portal — inline keyboard buttons from /billing
  bot.callbackQuery(CB_BILLING_UPGRADE, upgradeCallbackHandler);
  bot.callbackQuery(CB_BILLING_PORTAL, portalCallbackHandler);

  // upg:{priceKey} — plan selection buttons from /upgrade
  bot.callbackQuery(CB_UPGRADE_PLAN.pattern, upgradePlanCallbackHandler);

  // lang:{locale} — set bot language
  bot.callbackQuery(CB_LANGUAGE_SET.pattern, languageCallbackHandler);

  // lang:close — dismiss the language menu
  bot.callbackQuery(CB_LANGUAGE_CLOSE, languageCloseCallbackHandler);

  // ── Inline keyboard callbacks ───────────────────────────────────────────────

  // cs — back to chat selection
  bot.callbackQuery(CB_CHAT_SELECTION, async (ctx) => {
    await ctx.answerCallbackQuery();
    await editChatSelectionMenu(ctx, getDb());
  });

  // cm:{chatId} — chat management menu
  bot.callbackQuery(CB_CHAT_MENU.pattern, async (ctx) => {
    const chatId = BigInt(ctx.match[1]);
    if (!(await assertChatAccess(ctx, chatId))) return;
    await ctx.answerCallbackQuery();
    const chat = await findChatById(getDb(), chatId);
    if (!chat) {
      const messages = getMessages(await resolveLocale(ctx, getDb()));
      await ctx.answerCallbackQuery(messages.common.chatNotFoundShort);
      return;
    }
    await editChatManagementMenu(ctx, getDb(), ctx.match[1], chat.title);
  });

  // cl:{chatId} — alias list for a chat
  bot.callbackQuery(CB_ALIAS_LIST.pattern, async (ctx) => {
    const chatId = BigInt(ctx.match[1]);
    if (!(await assertChatAccess(ctx, chatId))) return;
    await ctx.answerCallbackQuery();
    const chat = await findChatById(getDb(), chatId);
    const title = chat?.title ?? `Chat ${ctx.match[1]}`;
    await editAliasListMenu(ctx, getDb(), chatId, title);
  });

  // cn:{chatId} — start new email flow
  bot.callbackQuery(CB_NEW_EMAIL.pattern, async (ctx) => {
    const chatId = BigInt(ctx.match[1]);
    if (!(await assertHostedChatWorkspaceReady(ctx, chatId))) return;
    if (!(await assertChatAccess(ctx, chatId))) return;
    await ctx.answerCallbackQuery();
    if (!ctx.from) return;
    const chat = await findChatById(getDb(), chatId);
    const chatTitle = chat?.title ?? `Chat ${ctx.match[1]}`;

    await promptForEmailAliasName(ctx, chatId, chatTitle, null, "edit");
  });

  // ns:{chatId} — skip (random alias)
  bot.callbackQuery(CB_SKIP_ALIAS.pattern, async (ctx) => {
    const chatId = BigInt(ctx.match[1]);
    if (!(await assertHostedChatWorkspaceReady(ctx, chatId))) return;
    if (!(await assertChatAccess(ctx, chatId))) return;
    await ctx.answerCallbackQuery();
    if (!ctx.from) return;
    clearPending(ctx.from.id);
    const chat = await findChatById(getDb(), chatId);
    const chatTitle = chat?.title;
    await ctx.deleteMessage().catch(() => {});
    await createEmailAlias(ctx, "", chatId, null, chatTitle);
  });

  // nc — cancel new email
  bot.callbackQuery(CB_NEW_CANCEL, async (ctx) => {
    const messages = getMessages(await resolveLocale(ctx, getDb()));
    await ctx.answerCallbackQuery(messages.newemail.cancelledToast);
    if (ctx.from) clearPending(ctx.from.id);
    await editChatSelectionMenu(ctx, getDb());
  });

  // am:{aliasId} — alias detail menu
  bot.callbackQuery(CB_ALIAS_DETAIL.pattern, async (ctx) => {
    if (!(await assertAliasAccess(ctx, ctx.match[1]))) return;
    await ctx.answerCallbackQuery();
    await editAliasDetailMenu(ctx, getDb(), ctx.match[1]);
  });

  // ap:{aliasId} — pause alias
  bot.callbackQuery(CB_ALIAS_PAUSE.pattern, async (ctx) => {
    if (!(await assertAliasAccess(ctx, ctx.match[1]))) return;
    const messages = getMessages(await resolveLocale(ctx, getDb()));
    await ctx.answerCallbackQuery(messages.aliasActions.pausedToast);
    await updateAliasStatus(getDb(), ctx.match[1], "paused");
    await editAliasDetailMenu(ctx, getDb(), ctx.match[1]);
  });

  // ar:{aliasId} — resume alias
  bot.callbackQuery(CB_ALIAS_RESUME.pattern, async (ctx) => {
    if (!(await assertAliasAccess(ctx, ctx.match[1]))) return;
    const messages = getMessages(await resolveLocale(ctx, getDb()));
    await ctx.answerCallbackQuery(messages.aliasActions.resumedToast);
    await updateAliasStatus(getDb(), ctx.match[1], "active");
    await editAliasDetailMenu(ctx, getDb(), ctx.match[1]);
  });

  // ad:{aliasId} — ask for delete confirmation
  bot.callbackQuery(CB_ALIAS_DELETE.pattern, async (ctx) => {
    if (!(await assertAliasAccess(ctx, ctx.match[1]))) return;
    await ctx.answerCallbackQuery();
    await editAliasDeleteConfirmMenu(ctx, getDb(), ctx.match[1]);
  });

  // adx:{aliasId} — cancel delete confirmation
  bot.callbackQuery(CB_ALIAS_DELETE_CANCEL.pattern, async (ctx) => {
    if (!(await assertAliasAccess(ctx, ctx.match[1]))) return;
    const messages = getMessages(await resolveLocale(ctx, getDb()));
    await ctx.answerCallbackQuery(messages.aliasActions.keptToast);
    await editAliasDetailMenu(ctx, getDb(), ctx.match[1]);
  });

  // adc:{aliasId} — confirmed delete alias
  bot.callbackQuery(CB_ALIAS_DELETE_CONFIRM.pattern, async (ctx) => {
    if (!(await assertAliasAccess(ctx, ctx.match[1]))) return;
    const messages = getMessages(await resolveLocale(ctx, getDb()));
    await ctx.answerCallbackQuery(messages.aliasActions.deletedToast);
    const alias = await findAliasById(getDb(), ctx.match[1]);
    if (alias) {
      await updateAliasStatus(getDb(), alias.id, "deleted");
      const chat = await findChatById(getDb(), alias.chatId);
      const title = chat?.title ?? alias.chatId.toString();
      await editAliasListMenu(ctx, getDb(), alias.chatId, title);
    }
  });

  // ac:{aliasId} — alias settings
  bot.callbackQuery(CB_ALIAS_SETTINGS.pattern, async (ctx) => {
    if (!(await assertAliasAccess(ctx, ctx.match[1]))) return;
    await ctx.answerCallbackQuery();
    const alias = await findAliasById(getDb(), ctx.match[1]);
    if (!alias) return;
    const locale = await resolveLocale(ctx, getDb());
    await ctx.editMessageText(buildAliasSettingsText(alias, locale), {
      parse_mode: "HTML",
      reply_markup: buildAliasSettingsKeyboard(alias, true, locale),
    });
  });

  // set_mode:{aliasId}:{mode} — apply render mode
  bot.callbackQuery(CB_SET_MODE.pattern, async (ctx) => {
    const [, aliasId, mode] = ctx.match;
    if (!(await assertAliasAccess(ctx, aliasId))) return;
    const messages = getMessages(await resolveLocale(ctx, getDb()));
    const validModes = ["plaintext", "html", "markdown"];
    if (!validModes.includes(mode)) {
      await ctx.answerCallbackQuery(messages.settingsCommand.invalidModeToast);
      return;
    }
    await updateAliasRenderMode(getDb(), aliasId, mode as "plaintext" | "html" | "markdown");
    await ctx.answerCallbackQuery(messages.settingsCommand.modeSetToast(mode));
    const alias = await findAliasById(getDb(), aliasId);
    if (!alias) return;
    const locale = await resolveLocale(ctx, getDb());
    await ctx.editMessageText(buildAliasSettingsText(alias, locale), {
      parse_mode: "HTML",
      reply_markup: buildAliasSettingsKeyboard(alias, true, locale),
    });
  });

  // toggle_body_dedup:{aliasId} — toggle body-hash dedup for an alias
  bot.callbackQuery(CB_TOGGLE_BODY_DEDUP.pattern, async (ctx) => {
    const aliasId = ctx.match[1];
    if (!(await assertAliasAccess(ctx, aliasId))) return;
    const messages = getMessages(await resolveLocale(ctx, getDb()));
    const alias = await findAliasById(getDb(), aliasId);
    if (!alias) {
      await ctx.answerCallbackQuery(messages.common.aliasNotFoundShort);
      return;
    }

    const nextValue = !alias.bodyDedupEnabled;
    await updateAliasBodyDedup(getDb(), aliasId, nextValue);
    await ctx.answerCallbackQuery(messages.settingsCommand.bodyDedupToast(nextValue));

    const updatedAlias = await findAliasById(getDb(), aliasId);
    if (!updatedAlias) return;
    const locale = await resolveLocale(ctx, getDb());
    await ctx.editMessageText(buildAliasSettingsText(updatedAlias, locale), {
      parse_mode: "HTML",
      reply_markup: buildAliasSettingsKeyboard(updatedAlias, true, locale),
    });
  });

  // toggle_privacy_mode:{aliasId} — toggle privacy mode for an alias
  bot.callbackQuery(CB_TOGGLE_PRIVACY_MODE.pattern, async (ctx) => {
    const aliasId = ctx.match[1];
    if (!(await assertAliasAccess(ctx, aliasId))) return;
    const messages = getMessages(await resolveLocale(ctx, getDb()));
    const alias = await findAliasById(getDb(), aliasId);
    if (!alias) {
      await ctx.answerCallbackQuery(messages.common.aliasNotFoundShort);
      return;
    }

    const nextValue = !alias.privacyModeEnabled;
    await updateAliasPrivacyMode(getDb(), aliasId, nextValue);
    await ctx.answerCallbackQuery(messages.settingsCommand.privacyToast(nextValue));

    const updatedAlias = await findAliasById(getDb(), aliasId);
    if (!updatedAlias) return;
    const locale = await resolveLocale(ctx, getDb());
    await ctx.editMessageText(buildAliasSettingsText(updatedAlias, locale), {
      parse_mode: "HTML",
      reply_markup: buildAliasSettingsKeyboard(updatedAlias, true, locale),
    });
  });

  // al:{aliasId} — allow rules menu
  bot.callbackQuery(CB_ALLOW_RULES.pattern, async (ctx) => {
    if (!(await assertAliasAccess(ctx, ctx.match[1]))) return;
    await ctx.answerCallbackQuery();
    await editAllowRulesMenu(ctx, getDb(), ctx.match[1]);
  });

  // dr:{ruleId} — delete allow rule
  bot.callbackQuery(CB_DELETE_RULE.pattern, async (ctx) => {
    const messages = getMessages(await resolveLocale(ctx, getDb()));
    const rule = await findAllowRuleById(getDb(), ctx.match[1]);
    if (!rule) {
      await ctx.answerCallbackQuery(messages.common.ruleNotFoundShort);
      return;
    }
    // Answer Telegram promptly before the async access check (Telegram requires ≤10s)
    await ctx.answerCallbackQuery(messages.allowCommand.removedToast);
    if (!(await assertAliasAccess(ctx, rule.emailAddressId))) return;
    await removeAllowRule(getDb(), {
      emailAddressId: rule.emailAddressId,
      matchValue: rule.matchValue,
    });
    await editAllowRulesMenu(ctx, getDb(), rule.emailAddressId);
  });

  // aa:{aliasId} — start add allow rule flow
  bot.callbackQuery(CB_ADD_RULE.pattern, async (ctx) => {
    if (!(await assertHostedAliasWorkspaceReady(ctx, ctx.match[1]))) return;
    if (!(await assertAliasAccess(ctx, ctx.match[1]))) return;
    await ctx.answerCallbackQuery();
    if (!ctx.from) return;
    const alias = await findAliasById(getDb(), ctx.match[1]);
    if (!alias) return;

    setPending(ctx.from.id, {
      action: "allowrule",
      aliasId: alias.id,
      aliasLocalPart: alias.localPart,
    });

    const locale = await resolveLocale(ctx, getDb());
    const messages = getMessages(locale);
    const keyboard = buildQuickAllowKeyboard(alias.id, "rules", locale)
      .row()
      .text(messages.newemail.cancelButton, CB_CANCEL_ADD_RULE.build(alias.id));
    await ctx.editMessageText(messages.allowCommand.addRulePrompt(escapeHtml(alias.localPart)), {
      parse_mode: "HTML",
      reply_markup: keyboard,
    });
  });

  // na:{aliasId} — cancel add allow rule
  bot.callbackQuery(CB_CANCEL_ADD_RULE.pattern, async (ctx) => {
    if (!(await assertAliasAccess(ctx, ctx.match[1]))) return;
    const messages = getMessages(await resolveLocale(ctx, getDb()));
    await ctx.answerCallbackQuery(messages.aliasActions.cancelledToast);
    if (ctx.from) clearPending(ctx.from.id);
    await editAllowRulesMenu(ctx, getDb(), ctx.match[1]);
  });

  // qa:{aliasId}:{domain} — quick-add allow domain
  bot.callbackQuery(CB_QUICK_ALLOW.pattern, async (ctx) => {
    const aliasId = ctx.match[1];
    const domain = ctx.match[2];
    if (!(await assertHostedAliasWorkspaceReady(ctx, aliasId))) return;
    if (!(await assertAliasAccess(ctx, aliasId))) return;
    const messages = getMessages(await resolveLocale(ctx, getDb()));
    const alias = await findAliasById(getDb(), aliasId);
    if (!alias) {
      await ctx.answerCallbackQuery(messages.common.aliasNotFoundShort);
      return;
    }
    await ctx.answerCallbackQuery(messages.allowCommand.addingToast);
    const added = await addAllowRuleForAlias(ctx, getDb(), alias, domain);
    if (added) {
      // Show the alias detail menu so the user sees the new state and next steps.
      await editAliasDetailMenu(ctx, getDb(), aliasId).catch(() => {});
    }
  });

  // qr:{aliasId}:{domain} — quick-add allow domain and return to allow-rules menu
  bot.callbackQuery(CB_QUICK_ALLOW_RULES.pattern, async (ctx) => {
    const aliasId = ctx.match[1];
    const domain = ctx.match[2];
    if (!(await assertHostedAliasWorkspaceReady(ctx, aliasId))) return;
    if (!(await assertAliasAccess(ctx, aliasId))) return;
    const messages = getMessages(await resolveLocale(ctx, getDb()));
    const alias = await findAliasById(getDb(), aliasId);
    if (!alias) {
      await ctx.answerCallbackQuery(messages.common.aliasNotFoundShort);
      return;
    }
    await ctx.answerCallbackQuery(messages.allowCommand.addingToast);
    const added = await addAllowRuleForAlias(ctx, getDb(), alias, domain);
    if (added) {
      await editAllowRulesMenu(ctx, getDb(), aliasId).catch(() => {});
    }
  });

  // ale:{aliasId} — start label-edit flow
  bot.callbackQuery(CB_ALIAS_LABEL_EDIT.pattern, async (ctx) => {
    const aliasId = ctx.match[1];
    if (!(await assertAliasAccess(ctx, aliasId))) return;
    await ctx.answerCallbackQuery();
    if (!ctx.from) return;
    const alias = await findAliasById(getDb(), aliasId);
    if (!alias) return;

    setPending(ctx.from.id, {
      action: "alias_label",
      aliasId,
      promptChatId: ctx.callbackQuery.message?.chat.id,
      promptMessageId: ctx.callbackQuery.message?.message_id,
    });

    const messages = getMessages(await resolveLocale(ctx, getDb()));
    const keyboard = new InlineKeyboard().text(
      messages.label.cancelButton,
      CB_ALIAS_LABEL_CANCEL.build(aliasId),
    );
    await ctx.editMessageText(
      messages.label.prompt(
        escapeHtml(alias.fullAddress),
        alias.label ? escapeHtml(alias.label) : null,
      ),
      { parse_mode: "HTML", reply_markup: keyboard },
    );
  });

  // alc:{aliasId} — clear label
  bot.callbackQuery(CB_ALIAS_LABEL_CLEAR.pattern, async (ctx) => {
    const aliasId = ctx.match[1];
    if (!(await assertAliasAccess(ctx, aliasId))) return;
    const messages = getMessages(await resolveLocale(ctx, getDb()));
    await updateAliasLabel(getDb(), aliasId, null);
    await ctx.answerCallbackQuery(messages.label.clearedToast);
    await editAliasDetailMenu(ctx, getDb(), aliasId);
  });

  // alx:{aliasId} — cancel label-edit
  bot.callbackQuery(CB_ALIAS_LABEL_CANCEL.pattern, async (ctx) => {
    const aliasId = ctx.match[1];
    if (!(await assertAliasAccess(ctx, aliasId))) return;
    if (ctx.from) clearPending(ctx.from.id);
    const messages = getMessages(await resolveLocale(ctx, getDb()));
    await ctx.answerCallbackQuery(messages.label.cancelledToast);
    await editAliasDetailMenu(ctx, getDb(), aliasId);
  });

  return bot;
}

/**
 * Pushes the localized bot-command menu (the autocomplete shown on `/` in
 * Telegram) to the Bot API for every supported locale, plus a default that
 * Telegram falls back to for unknown languages.
 *
 * Idempotent — Telegram stores the last value per `language_code`. Call once
 * at startup after `getMe` so the bot is initialized.
 */
export async function syncBotCommands(bot: Bot): Promise<void> {
  // Default (no language_code) — used by Telegram when the user's interface
  // language doesn't match any explicit variant. Set to the project's default.
  await bot.api.setMyCommands(getMessages(DEFAULT_LOCALE).botCommands);
  for (const locale of SUPPORTED_LOCALES) {
    if (locale === DEFAULT_LOCALE) continue;
    await bot.api.setMyCommands(getMessages(locale).botCommands, {
      language_code: locale,
    });
  }
}

/**
 * /label <alias-name> <text…> — sets an alias label.
 *
 * Use `/label <alias-name> --clear` to remove an existing label. Calling the
 * command without a label argument shows usage so users don't accidentally
 * wipe their existing label.
 */
async function labelHandler(ctx: Context): Promise<void> {
  if (!ctx.from) return;
  const locale = await resolveLocale(ctx, getDb());
  const messages = getMessages(locale);
  const raw = (ctx as Context & { match?: string }).match ?? "";
  const trimmed = String(raw).trim();
  if (!trimmed) {
    await ctx.reply(messages.label.usage, { parse_mode: "HTML" });
    return;
  }
  const firstSpace = trimmed.indexOf(" ");
  const aliasName = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
  const labelInput = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1).trim();

  // No label text → show usage rather than silently clearing the label.
  if (!labelInput) {
    await ctx.reply(messages.label.usage, { parse_mode: "HTML" });
    return;
  }

  const result = await resolveManageableAlias(
    getDb(),
    ctx.api,
    ctx.from.id,
    BigInt(ctx.chat!.id),
    aliasName,
    ctx.chat!.type,
  );
  if (!result.ok) {
    await ctx.reply(aliasResolutionError(result, aliasName, ctx.chat!.type, locale), {
      parse_mode: "HTML",
    });
    return;
  }

  const alias = result.alias;
  if (labelInput === "--clear") {
    await updateAliasLabel(getDb(), alias.id, null);
    await ctx.reply(messages.label.cleared(escapeHtml(alias.fullAddress)), {
      parse_mode: "HTML",
    });
    return;
  }
  if (labelInput.length > 64) {
    await ctx.reply(messages.label.tooLong);
    return;
  }
  await updateAliasLabel(getDb(), alias.id, labelInput);
  await ctx.reply(
    messages.label.setSuccess(escapeHtml(labelInput), escapeHtml(alias.fullAddress)),
    { parse_mode: "HTML" },
  );
}

export async function handlePendingTextMessage(ctx: Context, next: NextFunction): Promise<void> {
  if (!ctx.from) return next();
  const text = ctx.message?.text ?? "";

  // Let commands pass through; cancel pending action and notify
  if (text.startsWith("/")) {
    clearPending(ctx.from.id);
    return next();
  }

  const pending = getPending(ctx.from.id);
  if (!pending) return next();

  if (pending.action === "newemail") {
    const messages = getMessages(await resolveLocale(ctx, getDb()));
    const pendingChat = await findChatById(getDb(), pending.chatId);
    if (!(await hasActiveHostedOrganization(getDb(), pendingChat?.organizationId ?? null))) {
      clearPending(ctx.from.id);
      await ctx.reply(messages.common.hostedWorkspaceInactive);
      return;
    }

    if (!(await canManageChat(ctx.api, ctx.from.id, pending.chatId, { fresh: true }))) {
      clearPending(ctx.from.id);
      await ctx.reply(messages.common.accessDenied);
      return;
    }
    clearPending(ctx.from.id);
    await createEmailAlias(
      ctx,
      text.trim(),
      pending.chatId,
      pending.messageThreadId ?? null,
      pending.chatTitle,
    );
    return;
  }

  if (pending.action === "alias_label") {
    const messages = getMessages(await resolveLocale(ctx, getDb()));
    const alias = await findAliasById(getDb(), pending.aliasId);
    if (!alias) {
      clearPending(ctx.from.id);
      await ctx.reply(messages.common.aliasNotFound);
      return;
    }
    if (!(await canManageAlias(getDb(), ctx.api, ctx.from.id, pending.aliasId, { fresh: true }))) {
      clearPending(ctx.from.id);
      await ctx.reply(messages.common.accessDenied);
      return;
    }
    const labelInput = text.trim();
    if (!labelInput) {
      await ctx.reply(messages.label.emptyInput);
      return;
    }
    if (labelInput.length > 64) {
      await ctx.reply(messages.label.tooLong);
      return;
    }
    clearPending(ctx.from.id);
    await updateAliasLabel(getDb(), pending.aliasId, labelInput);
    await clearPromptKeyboard(ctx, pending);
    await sendAliasDetailMenu(ctx, getDb(), pending.aliasId);
    return;
  }

  if (pending.action !== "allowrule") return;

  const messages = getMessages(await resolveLocale(ctx, getDb()));
  const alias = await findAliasById(getDb(), pending.aliasId);
  if (!alias) {
    clearPending(ctx.from.id);
    await ctx.reply(messages.common.aliasNotFound);
    return;
  }
  if (!(await hasActiveHostedOrganization(getDb(), alias.organizationId ?? null))) {
    clearPending(ctx.from.id);
    await ctx.reply(messages.allowCommand.subscriptionInactive(escapeHtml(alias.localPart)), {
      parse_mode: "HTML",
    });
    return;
  }
  if (!(await canManageAlias(getDb(), ctx.api, ctx.from.id, pending.aliasId, { fresh: true }))) {
    clearPending(ctx.from.id);
    await ctx.reply(messages.common.accessDenied);
    return;
  }
  clearPending(ctx.from.id);
  const parsedValue = parseAllowValue(text);
  if (!parsedValue) {
    await ctx.reply(messages.allowCommand.invalidFormat, { parse_mode: "HTML" });
    return;
  }
  if (!(await addAllowRuleForAlias(ctx, getDb(), alias, text))) {
    return;
  }
  await sendAllowRulesMenu(ctx, getDb(), pending.aliasId);
}

async function clearPromptKeyboard(
  ctx: Context,
  pending: { promptChatId?: number; promptMessageId?: number },
): Promise<void> {
  if (!pending.promptChatId || !pending.promptMessageId) return;
  await ctx.api
    .editMessageReplyMarkup(pending.promptChatId, pending.promptMessageId, {
      reply_markup: undefined,
    })
    .catch(() => {});
}
