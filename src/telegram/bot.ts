import { Bot } from "grammy";
import { getDb } from "../db/client.js";
import { authMiddleware } from "./middleware/auth.js";
import { startHandler } from "./commands/start.js";
import { newemailHandler, createEmailAlias } from "./commands/newemail.js";
import { listemailHandler } from "./commands/listemail.js";
import { deleteemailHandler } from "./commands/deleteemail.js";
import { pauseemailHandler } from "./commands/pauseemail.js";
import { resumeemailHandler } from "./commands/resumeemail.js";
import { settingsHandler } from "./commands/settings.js";
import { allowHandler } from "./commands/allow.js";
import { helpHandler } from "./commands/help.js";
import { chatMemberHandler } from "./handlers/chatMember.js";
import { editChatSelectionMenu, editChatManagementMenu } from "./menu/chatMenu.js";
import { editAliasListMenu, editAliasDetailMenu } from "./menu/aliasMenu.js";
import { findAliasById, updateAliasStatus, updateAliasRenderMode } from "../db/repos/aliases.js";
import { findChatById } from "../db/repos/chats.js";
import { getPending, clearPending, setPending } from "./session.js";
import { getLogger } from "../utils/logger.js";
import { InlineKeyboard } from "grammy";

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
  bot.on("message:text", async (ctx, next) => {
    if (!ctx.from) return next();
    const text = ctx.message.text;

    // Let commands pass through; cancel pending action and notify
    if (text.startsWith("/")) {
      clearPending(ctx.from.id);
      return next();
    }

    const pending = getPending(ctx.from.id);
    if (!pending) return next();

    if (pending.action === "newemail") {
      clearPending(ctx.from.id);
      await createEmailAlias(ctx, text.trim(), pending.chatId, null, pending.chatTitle);
    }
  });

  // ── Commands ────────────────────────────────────────────────────────────────
  bot.command("newemail", newemailHandler);
  bot.command("listemail", listemailHandler);
  bot.command("deleteemail", deleteemailHandler);
  bot.command("pauseemail", pauseemailHandler);
  bot.command("resumeemail", resumeemailHandler);
  bot.command("settings", settingsHandler);
  bot.command("allow", allowHandler);
  bot.command("help", helpHandler);

  // ── Inline keyboard callbacks ───────────────────────────────────────────────

  // cs — back to chat selection
  bot.callbackQuery("cs", async (ctx) => {
    await ctx.answerCallbackQuery();
    await editChatSelectionMenu(ctx, getDb());
  });

  // cm:{chatId} — chat management menu
  bot.callbackQuery(/^cm:(-?\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const chatId = BigInt(ctx.match[1]);
    const chat = await findChatById(getDb(), chatId);
    if (!chat) {
      await ctx.answerCallbackQuery("Chat not found.");
      return;
    }
    await editChatManagementMenu(ctx, ctx.match[1], chat.title);
  });

  // cl:{chatId} — alias list for a chat
  bot.callbackQuery(/^cl:(-?\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const chatId = BigInt(ctx.match[1]);
    const chat = await findChatById(getDb(), chatId);
    const title = chat?.title ?? `Chat ${ctx.match[1]}`;
    await editAliasListMenu(ctx, getDb(), chatId, title);
  });

  // cn:{chatId} — start new email flow
  bot.callbackQuery(/^cn:(-?\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.from) return;
    const chatId = BigInt(ctx.match[1]);
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
    await ctx.answerCallbackQuery();
    if (!ctx.from) return;
    clearPending(ctx.from.id);
    const chatId = BigInt(ctx.match[1]);
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
    await ctx.answerCallbackQuery();
    await editAliasDetailMenu(ctx, getDb(), ctx.match[1]);
  });

  // ap:{aliasId} — pause alias
  bot.callbackQuery(/^ap:([0-9a-f-]{36})$/, async (ctx) => {
    await ctx.answerCallbackQuery("Paused.");
    await updateAliasStatus(getDb(), ctx.match[1], "paused");
    await editAliasDetailMenu(ctx, getDb(), ctx.match[1]);
  });

  // ar:{aliasId} — resume alias
  bot.callbackQuery(/^ar:([0-9a-f-]{36})$/, async (ctx) => {
    await ctx.answerCallbackQuery("Resumed.");
    await updateAliasStatus(getDb(), ctx.match[1], "active");
    await editAliasDetailMenu(ctx, getDb(), ctx.match[1]);
  });

  // ad:{aliasId} — delete alias
  bot.callbackQuery(/^ad:([0-9a-f-]{36})$/, async (ctx) => {
    await ctx.answerCallbackQuery("Deleted.");
    const alias = await findAliasById(getDb(), ctx.match[1]);
    if (alias) {
      await updateAliasStatus(getDb(), alias.id, "deleted");
      const chat = await findChatById(getDb(), alias.chatId);
      const title = chat?.title ?? alias.chatId.toString();
      await editAliasListMenu(ctx, getDb(), alias.chatId, title);
    }
  });

  // ac:{aliasId} — render mode settings
  bot.callbackQuery(/^ac:([0-9a-f-]{36})$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const alias = await findAliasById(getDb(), ctx.match[1]);
    if (!alias) return;
    const keyboard = new InlineKeyboard();
    for (const mode of ["plaintext", "html", "markdown"] as const) {
      const tick = mode === alias.renderMode ? "✓ " : "";
      keyboard.text(`${tick}${mode}`, `set_mode:${alias.id}:${mode}`);
    }
    keyboard.row().text("⬅️ Back", `am:${alias.id}`);
    await ctx.editMessageText(
      `⚙️ Render mode for <code>${escapeHtml(alias.fullAddress)}</code>\nCurrent: <b>${alias.renderMode}</b>`,
      { parse_mode: "HTML", reply_markup: keyboard },
    );
  });

  // set_mode:{aliasId}:{mode} — apply render mode (existing + from new menu)
  bot.callbackQuery(/^set_mode:(.+):(.+)$/, async (ctx) => {
    const [, aliasId, mode] = ctx.match;
    const validModes = ["plaintext", "html", "markdown"];
    if (!validModes.includes(mode)) {
      await ctx.answerCallbackQuery("Invalid mode");
      return;
    }
    await updateAliasRenderMode(getDb(), aliasId, mode as "plaintext" | "html" | "markdown");
    await ctx.answerCallbackQuery(`✅ Mode set to ${mode}`);
    // Return to alias detail if coming from the new menu flow
    await editAliasDetailMenu(ctx, getDb(), aliasId);
  });

  return bot;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
