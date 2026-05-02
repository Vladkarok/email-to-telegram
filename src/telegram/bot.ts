import { Bot, type Context, type CallbackQueryContext, type NextFunction } from "grammy";
import { getDb } from "../db/client.js";
import { authMiddleware } from "./middleware/auth.js";
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
import {
  billingHandler,
  BILLING_UPGRADE_CALLBACK,
  BILLING_PORTAL_CALLBACK,
} from "./commands/billing.js";
import {
  upgradeHandler,
  upgradeCallbackHandler,
  upgradePlanCallbackHandler,
  UPGRADE_PLAN_CALLBACK_PATTERN,
} from "./commands/upgrade.js";
import { portalHandler, portalCallbackHandler } from "./commands/portal.js";
import { chatMemberHandler } from "./handlers/chatMember.js";
import { editChatSelectionMenu, editChatManagementMenu } from "./menu/chatMenu.js";
import { editAliasListMenu, editAliasDetailMenu } from "./menu/aliasMenu.js";
import { sendAllowRulesMenu, editAllowRulesMenu } from "./menu/allowRulesMenu.js";
import {
  findAliasById,
  updateAliasBodyDedup,
  updateAliasPrivacyMode,
  updateAliasStatus,
  updateAliasRenderMode,
} from "../db/repos/aliases.js";
import { findChatById } from "../db/repos/chats.js";
import { findAllowRuleById, removeAllowRule } from "../db/repos/allowRules.js";
import { getPending, clearPending, setPending } from "./session.js";
import { canManageChat, canManageAlias } from "./authorization.js";
import { parseAllowValue } from "./allowValue.js";
import { getLogger } from "../utils/logger.js";
import { InlineKeyboard } from "grammy";
import { hasActiveHostedOrganization } from "../billing/limits.js";
import { escapeHtml } from "../utils/html.js";

// ── Authorization helpers ────────────────────────────────────────────────────

async function assertChatAccess(
  ctx: CallbackQueryContext<Context>,
  chatId: bigint,
): Promise<boolean> {
  if (!ctx.from) {
    await ctx.answerCallbackQuery("⛔ Access denied");
    return false;
  }
  const allowed = await canManageChat(ctx.api, ctx.from.id, chatId);
  if (!allowed) await ctx.answerCallbackQuery("⛔ Access denied");
  return allowed;
}

async function assertAliasAccess(
  ctx: CallbackQueryContext<Context>,
  aliasId: string,
): Promise<boolean> {
  if (!ctx.from) {
    await ctx.answerCallbackQuery("⛔ Access denied");
    return false;
  }
  const allowed = await canManageAlias(getDb(), ctx.api, ctx.from.id, aliasId);
  if (!allowed) await ctx.answerCallbackQuery("⛔ Access denied");
  return allowed;
}

export async function assertHostedChatWorkspaceReady(
  ctx: CallbackQueryContext<Context>,
  chatId: bigint,
): Promise<boolean> {
  const chat = await findChatById(getDb(), chatId);
  if (await hasActiveHostedOrganization(getDb(), chat?.organizationId ?? null)) {
    return true;
  }

  await ctx.answerCallbackQuery("⛔ Hosted workspace inactive");
  return false;
}

export async function assertHostedAliasWorkspaceReady(
  ctx: CallbackQueryContext<Context>,
  aliasId: string,
): Promise<boolean> {
  const alias = await findAliasById(getDb(), aliasId);
  if (!alias) return true;
  if (await hasActiveHostedOrganization(getDb(), alias.organizationId ?? null)) {
    return true;
  }

  await ctx.answerCallbackQuery("⛔ Hosted workspace inactive");
  return false;
}

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
  bot.command("help", helpHandler);
  bot.command("plan", planHandler);
  bot.command("usage", usageHandler);
  bot.command("billing", billingHandler);
  bot.command("upgrade", upgradeHandler);
  bot.command("portal", portalHandler);

  // bill:upgrade / bill:portal — inline keyboard buttons from /billing
  bot.callbackQuery(BILLING_UPGRADE_CALLBACK, upgradeCallbackHandler);
  bot.callbackQuery(BILLING_PORTAL_CALLBACK, portalCallbackHandler);

  // upg:{priceKey} — plan selection buttons from /upgrade
  bot.callbackQuery(UPGRADE_PLAN_CALLBACK_PATTERN, upgradePlanCallbackHandler);

  // ── Inline keyboard callbacks ───────────────────────────────────────────────

  // cs — back to chat selection
  bot.callbackQuery("cs", async (ctx) => {
    await ctx.answerCallbackQuery();
    await editChatSelectionMenu(ctx, getDb());
  });

  // cm:{chatId} — chat management menu
  bot.callbackQuery(/^cm:(-?\d+)$/, async (ctx) => {
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
  bot.callbackQuery(/^cl:(-?\d+)$/, async (ctx) => {
    const chatId = BigInt(ctx.match[1]);
    if (!(await assertChatAccess(ctx, chatId))) return;
    await ctx.answerCallbackQuery();
    const chat = await findChatById(getDb(), chatId);
    const title = chat?.title ?? `Chat ${ctx.match[1]}`;
    await editAliasListMenu(ctx, getDb(), chatId, title);
  });

  // cn:{chatId} — start new email flow
  bot.callbackQuery(/^cn:(-?\d+)$/, async (ctx) => {
    const chatId = BigInt(ctx.match[1]);
    if (!(await assertHostedChatWorkspaceReady(ctx, chatId))) return;
    if (!(await assertChatAccess(ctx, chatId))) return;
    await ctx.answerCallbackQuery();
    if (!ctx.from) return;
    const chat = await findChatById(getDb(), chatId);
    const chatTitle = chat?.title ?? `Chat ${ctx.match[1]}`;

    setPending(ctx.from.id, { action: "newemail", chatId, chatTitle });

    const keyboard = new InlineKeyboard()
      .text("⏭ Skip — random alias", `ns:${ctx.match[1]}`)
      .row()
      .text("✖ Cancel", "nc");

    await ctx.editMessageText(
      `📧 Creating alias for <b>${escapeHtml(chatTitle)}</b>\n\nSend me the alias prefix (e.g. <code>alerts</code>), or tap Skip for a random one.`,
      { parse_mode: "HTML", reply_markup: keyboard },
    );
  });

  // ns:{chatId} — skip (random alias)
  bot.callbackQuery(/^ns:(-?\d+)$/, async (ctx) => {
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
  bot.callbackQuery("nc", async (ctx) => {
    await ctx.answerCallbackQuery("Cancelled.");
    if (ctx.from) clearPending(ctx.from.id);
    await editChatSelectionMenu(ctx, getDb());
  });

  // am:{aliasId} — alias detail menu
  bot.callbackQuery(/^am:([0-9a-f-]{36})$/, async (ctx) => {
    if (!(await assertAliasAccess(ctx, ctx.match[1]))) return;
    await ctx.answerCallbackQuery();
    await editAliasDetailMenu(ctx, getDb(), ctx.match[1]);
  });

  // ap:{aliasId} — pause alias
  bot.callbackQuery(/^ap:([0-9a-f-]{36})$/, async (ctx) => {
    if (!(await assertAliasAccess(ctx, ctx.match[1]))) return;
    await ctx.answerCallbackQuery("Paused.");
    await updateAliasStatus(getDb(), ctx.match[1], "paused");
    await editAliasDetailMenu(ctx, getDb(), ctx.match[1]);
  });

  // ar:{aliasId} — resume alias
  bot.callbackQuery(/^ar:([0-9a-f-]{36})$/, async (ctx) => {
    if (!(await assertAliasAccess(ctx, ctx.match[1]))) return;
    await ctx.answerCallbackQuery("Resumed.");
    await updateAliasStatus(getDb(), ctx.match[1], "active");
    await editAliasDetailMenu(ctx, getDb(), ctx.match[1]);
  });

  // ad:{aliasId} — delete alias
  bot.callbackQuery(/^ad:([0-9a-f-]{36})$/, async (ctx) => {
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
  bot.callbackQuery(/^ac:([0-9a-f-]{36})$/, async (ctx) => {
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
  bot.callbackQuery(/^set_mode:(.+):(.+)$/, async (ctx) => {
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
  bot.callbackQuery(/^toggle_body_dedup:([0-9a-f-]{36})$/, async (ctx) => {
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
  bot.callbackQuery(/^toggle_privacy_mode:([0-9a-f-]{36})$/, async (ctx) => {
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
  bot.callbackQuery(/^al:([0-9a-f-]{36})$/, async (ctx) => {
    if (!(await assertAliasAccess(ctx, ctx.match[1]))) return;
    await ctx.answerCallbackQuery();
    await editAllowRulesMenu(ctx, getDb(), ctx.match[1]);
  });

  // dr:{ruleId} — delete allow rule
  bot.callbackQuery(/^dr:([0-9a-f-]{36})$/, async (ctx) => {
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
  bot.callbackQuery(/^aa:([0-9a-f-]{36})$/, async (ctx) => {
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

    const keyboard = new InlineKeyboard().text("✖ Cancel", `na:${alias.id}`);
    await ctx.editMessageText(
      `📋 Add allow rule for <code>${escapeHtml(alias.localPart)}</code>\n\nSend a domain (e.g. <code>github.com</code>) or email (e.g. <code>user@example.com</code>).`,
      { parse_mode: "HTML", reply_markup: keyboard },
    );
  });

  // na:{aliasId} — cancel add allow rule
  bot.callbackQuery(/^na:([0-9a-f-]{36})$/, async (ctx) => {
    if (!(await assertAliasAccess(ctx, ctx.match[1]))) return;
    await ctx.answerCallbackQuery("Cancelled.");
    if (ctx.from) clearPending(ctx.from.id);
    await editAllowRulesMenu(ctx, getDb(), ctx.match[1]);
  });

  return bot;
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

