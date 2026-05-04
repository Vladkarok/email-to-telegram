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
import { newemailHandler, createEmailAlias } from "./commands/newemail.js";
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
import { planHandler } from "./commands/plan.js";
import { usageHandler } from "./commands/usage.js";
import { billingHandler } from "./commands/billing.js";
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
  CB_ALIAS_LABEL_EDIT,
  CB_ALIAS_LABEL_CLEAR,
  CB_ALIAS_LABEL_CANCEL,
} from "./callbacks.js";
import { portalHandler, portalCallbackHandler } from "./commands/portal.js";
import { chatMemberHandler } from "./handlers/chatMember.js";
import { editChatSelectionMenu, editChatManagementMenu } from "./menu/chatMenu.js";
import { editAliasListMenu, editAliasDetailMenu } from "./menu/aliasMenu.js";
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
  bot.command("plan", planHandler);
  bot.command("usage", usageHandler);
  bot.command("billing", billingHandler);
  bot.command("upgrade", upgradeHandler);
  bot.command("portal", portalHandler);

  // bill:upgrade / bill:portal — inline keyboard buttons from /billing
  bot.callbackQuery(CB_BILLING_UPGRADE, upgradeCallbackHandler);
  bot.callbackQuery(CB_BILLING_PORTAL, portalCallbackHandler);

  // upg:{priceKey} — plan selection buttons from /upgrade
  bot.callbackQuery(CB_UPGRADE_PLAN.pattern, upgradePlanCallbackHandler);

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
      await ctx.answerCallbackQuery("Chat not found.");
      return;
    }
    await editChatManagementMenu(ctx, ctx.match[1], chat.title);
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

    setPending(ctx.from.id, { action: "newemail", chatId, chatTitle });

    const keyboard = new InlineKeyboard()
      .text("⏭ Skip — random alias", CB_SKIP_ALIAS.build(ctx.match[1]))
      .row()
      .text("✖ Cancel", CB_NEW_CANCEL);

    await ctx.editMessageText(
      `📧 Creating alias for <b>${escapeHtml(chatTitle)}</b>\n\nSend me the alias prefix (e.g. <code>alerts</code>), or tap Skip for a random one.`,
      { parse_mode: "HTML", reply_markup: keyboard },
    );
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
    await ctx.answerCallbackQuery("Cancelled.");
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
    await ctx.answerCallbackQuery("Paused.");
    await updateAliasStatus(getDb(), ctx.match[1], "paused");
    await editAliasDetailMenu(ctx, getDb(), ctx.match[1]);
  });

  // ar:{aliasId} — resume alias
  bot.callbackQuery(CB_ALIAS_RESUME.pattern, async (ctx) => {
    if (!(await assertAliasAccess(ctx, ctx.match[1]))) return;
    await ctx.answerCallbackQuery("Resumed.");
    await updateAliasStatus(getDb(), ctx.match[1], "active");
    await editAliasDetailMenu(ctx, getDb(), ctx.match[1]);
  });

  // ad:{aliasId} — delete alias
  bot.callbackQuery(CB_ALIAS_DELETE.pattern, async (ctx) => {
    if (!(await assertAliasAccess(ctx, ctx.match[1]))) return;
    await ctx.answerCallbackQuery("Deleted.");
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
    await ctx.editMessageText(buildAliasSettingsText(alias), {
      parse_mode: "HTML",
      reply_markup: buildAliasSettingsKeyboard(alias, true),
    });
  });

  // set_mode:{aliasId}:{mode} — apply render mode
  bot.callbackQuery(CB_SET_MODE.pattern, async (ctx) => {
    const [, aliasId, mode] = ctx.match;
    if (!(await assertAliasAccess(ctx, aliasId))) return;
    const validModes = ["plaintext", "html", "markdown"];
    if (!validModes.includes(mode)) {
      await ctx.answerCallbackQuery("Invalid mode");
      return;
    }
    await updateAliasRenderMode(getDb(), aliasId, mode as "plaintext" | "html" | "markdown");
    await ctx.answerCallbackQuery(`✅ Mode set to ${mode}`);
    const alias = await findAliasById(getDb(), aliasId);
    if (!alias) return;
    await ctx.editMessageText(buildAliasSettingsText(alias), {
      parse_mode: "HTML",
      reply_markup: buildAliasSettingsKeyboard(alias, true),
    });
  });

  // toggle_body_dedup:{aliasId} — toggle body-hash dedup for an alias
  bot.callbackQuery(CB_TOGGLE_BODY_DEDUP.pattern, async (ctx) => {
    const aliasId = ctx.match[1];
    if (!(await assertAliasAccess(ctx, aliasId))) return;
    const alias = await findAliasById(getDb(), aliasId);
    if (!alias) {
      await ctx.answerCallbackQuery("Alias not found");
      return;
    }

    const nextValue = !alias.bodyDedupEnabled;
    await updateAliasBodyDedup(getDb(), aliasId, nextValue);
    await ctx.answerCallbackQuery(`Body dedup ${nextValue ? "enabled" : "disabled"}`);

    const updatedAlias = await findAliasById(getDb(), aliasId);
    if (!updatedAlias) return;
    await ctx.editMessageText(buildAliasSettingsText(updatedAlias), {
      parse_mode: "HTML",
      reply_markup: buildAliasSettingsKeyboard(updatedAlias, true),
    });
  });

  // toggle_privacy_mode:{aliasId} — toggle privacy mode for an alias
  bot.callbackQuery(CB_TOGGLE_PRIVACY_MODE.pattern, async (ctx) => {
    const aliasId = ctx.match[1];
    if (!(await assertAliasAccess(ctx, aliasId))) return;
    const alias = await findAliasById(getDb(), aliasId);
    if (!alias) {
      await ctx.answerCallbackQuery("Alias not found");
      return;
    }

    const nextValue = !alias.privacyModeEnabled;
    await updateAliasPrivacyMode(getDb(), aliasId, nextValue);
    await ctx.answerCallbackQuery(`Privacy mode ${nextValue ? "enabled" : "disabled"}`);

    const updatedAlias = await findAliasById(getDb(), aliasId);
    if (!updatedAlias) return;
    await ctx.editMessageText(buildAliasSettingsText(updatedAlias), {
      parse_mode: "HTML",
      reply_markup: buildAliasSettingsKeyboard(updatedAlias, true),
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
    const rule = await findAllowRuleById(getDb(), ctx.match[1]);
    if (!rule) {
      await ctx.answerCallbackQuery("Rule not found.");
      return;
    }
    // Answer Telegram promptly before the async access check (Telegram requires ≤10s)
    await ctx.answerCallbackQuery("Rule removed.");
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

    const keyboard = new InlineKeyboard().text("✖ Cancel", CB_CANCEL_ADD_RULE.build(alias.id));
    await ctx.editMessageText(
      `📋 Add allow rule for <code>${escapeHtml(alias.localPart)}</code>\n\nSend a domain (e.g. <code>github.com</code>) or email (e.g. <code>user@example.com</code>).`,
      { parse_mode: "HTML", reply_markup: keyboard },
    );
  });

  // na:{aliasId} — cancel add allow rule
  bot.callbackQuery(CB_CANCEL_ADD_RULE.pattern, async (ctx) => {
    if (!(await assertAliasAccess(ctx, ctx.match[1]))) return;
    await ctx.answerCallbackQuery("Cancelled.");
    if (ctx.from) clearPending(ctx.from.id);
    await editAllowRulesMenu(ctx, getDb(), ctx.match[1]);
  });

  // qa:{aliasId}:{domain} — quick-add allow domain
  bot.callbackQuery(CB_QUICK_ALLOW.pattern, async (ctx) => {
    const aliasId = ctx.match[1];
    const domain = ctx.match[2];
    if (!(await assertHostedAliasWorkspaceReady(ctx, aliasId))) return;
    if (!(await assertAliasAccess(ctx, aliasId))) return;
    const alias = await findAliasById(getDb(), aliasId);
    if (!alias) {
      await ctx.answerCallbackQuery("Alias not found.");
      return;
    }
    await ctx.answerCallbackQuery("Adding…");
    const added = await addAllowRuleForAlias(ctx, getDb(), alias, domain);
    if (added) {
      // Show the alias detail menu so the user sees the new state and next steps.
      await editAliasDetailMenu(ctx, getDb(), aliasId).catch(() => {});
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

    setPending(ctx.from.id, { action: "alias_label", aliasId });

    const keyboard = new InlineKeyboard().text("✖ Cancel", CB_ALIAS_LABEL_CANCEL.build(aliasId));
    const current = alias.label ? `\n\nCurrent label: <b>${escapeHtml(alias.label)}</b>` : "";
    await ctx.editMessageText(
      `🏷️ Set label for <code>${escapeHtml(alias.fullAddress)}</code>${current}\n\nSend the new label (max 64 characters), or tap Cancel.`,
      { parse_mode: "HTML", reply_markup: keyboard },
    );
  });

  // alc:{aliasId} — clear label
  bot.callbackQuery(CB_ALIAS_LABEL_CLEAR.pattern, async (ctx) => {
    const aliasId = ctx.match[1];
    if (!(await assertAliasAccess(ctx, aliasId))) return;
    await updateAliasLabel(getDb(), aliasId, null);
    await ctx.answerCallbackQuery("Label cleared.");
    await editAliasDetailMenu(ctx, getDb(), aliasId);
  });

  // alx:{aliasId} — cancel label-edit
  bot.callbackQuery(CB_ALIAS_LABEL_CANCEL.pattern, async (ctx) => {
    const aliasId = ctx.match[1];
    if (!(await assertAliasAccess(ctx, aliasId))) return;
    if (ctx.from) clearPending(ctx.from.id);
    await ctx.answerCallbackQuery("Cancelled.");
    await editAliasDetailMenu(ctx, getDb(), aliasId);
  });

  return bot;
}

/**
 * /label <alias-name> <text…> — sets or clears an alias label.
 *
 * Pass an empty `<text>` to clear the label.
 */
async function labelHandler(ctx: Context): Promise<void> {
  if (!ctx.from) return;
  const raw = (ctx as Context & { match?: string }).match ?? "";
  const trimmed = String(raw).trim();
  if (!trimmed) {
    await ctx.reply("Usage: /label <alias-name> <text>\n• To clear: /label <alias-name> --clear", {
      parse_mode: "HTML",
    });
    return;
  }
  const firstSpace = trimmed.indexOf(" ");
  const aliasName = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
  const labelInput = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1).trim();

  const result = await resolveManageableAlias(
    getDb(),
    ctx.api,
    ctx.from.id,
    BigInt(ctx.chat!.id),
    aliasName,
  );
  if (!result.ok) {
    await ctx.reply(aliasResolutionError(result, aliasName, ctx.chat!.type), {
      parse_mode: "HTML",
    });
    return;
  }

  const alias = result.alias;
  if (!labelInput || labelInput === "--clear") {
    await updateAliasLabel(getDb(), alias.id, null);
    await ctx.reply(`🧹 Label cleared for <code>${escapeHtml(alias.fullAddress)}</code>.`, {
      parse_mode: "HTML",
    });
    return;
  }
  if (labelInput.length > 64) {
    await ctx.reply("❌ Label too long. Max 64 characters.");
    return;
  }
  await updateAliasLabel(getDb(), alias.id, labelInput);
  await ctx.reply(
    `🏷️ Label set: <b>${escapeHtml(labelInput)}</b> · <code>${escapeHtml(alias.fullAddress)}</code>`,
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
    const pendingChat = await findChatById(getDb(), pending.chatId);
    if (!(await hasActiveHostedOrganization(getDb(), pendingChat?.organizationId ?? null))) {
      clearPending(ctx.from.id);
      await ctx.reply("⛔ This hosted workspace is not ready for alias creation right now.");
      return;
    }

    if (!(await canManageChat(ctx.api, ctx.from.id, pending.chatId, { fresh: true }))) {
      clearPending(ctx.from.id);
      await ctx.reply("⛔ Access denied.");
      return;
    }
    clearPending(ctx.from.id);
    await createEmailAlias(ctx, text.trim(), pending.chatId, null, pending.chatTitle);
    return;
  }

  if (pending.action === "alias_label") {
    const alias = await findAliasById(getDb(), pending.aliasId);
    if (!alias) {
      clearPending(ctx.from.id);
      await ctx.reply("❌ Alias not found.");
      return;
    }
    if (!(await canManageAlias(getDb(), ctx.api, ctx.from.id, pending.aliasId, { fresh: true }))) {
      clearPending(ctx.from.id);
      await ctx.reply("⛔ Access denied.");
      return;
    }
    clearPending(ctx.from.id);
    const labelInput = text.trim();
    if (!labelInput) {
      await ctx.reply("❌ Label cannot be empty. Try again or tap Cancel.");
      return;
    }
    if (labelInput.length > 64) {
      await ctx.reply("❌ Label too long. Max 64 characters.");
      return;
    }
    await updateAliasLabel(getDb(), pending.aliasId, labelInput);
    await ctx.reply(
      `🏷️ Label set: <b>${escapeHtml(labelInput)}</b> · <code>${escapeHtml(alias.fullAddress)}</code>`,
      { parse_mode: "HTML" },
    );
    return;
  }

  if (pending.action !== "allowrule") return;

  const alias = await findAliasById(getDb(), pending.aliasId);
  if (!alias) {
    clearPending(ctx.from.id);
    await ctx.reply("❌ Alias not found.");
    return;
  }
  if (!(await hasActiveHostedOrganization(getDb(), alias.organizationId ?? null))) {
    clearPending(ctx.from.id);
    await ctx.reply(
      `⛔ <code>${escapeHtml(alias.localPart)}</code> is not attached to an active hosted workspace.`,
      { parse_mode: "HTML" },
    );
    return;
  }
  if (!(await canManageAlias(getDb(), ctx.api, ctx.from.id, pending.aliasId, { fresh: true }))) {
    clearPending(ctx.from.id);
    await ctx.reply("⛔ Access denied.");
    return;
  }
  clearPending(ctx.from.id);
  const parsedValue = parseAllowValue(text);
  if (!parsedValue) {
    await ctx.reply(
      "❌ Invalid format. Use a domain (e.g. <code>github.com</code>) or email (e.g. <code>user@example.com</code>).",
      { parse_mode: "HTML" },
    );
    return;
  }
  if (!(await addAllowRuleForAlias(ctx, getDb(), alias, text))) {
    return;
  }
  await sendAllowRulesMenu(ctx, getDb(), pending.aliasId);
}
