import type { Context } from "grammy";
import { loadConfig } from "../../config.js";
import { getDb } from "../../db/client.js";
import { upsertChat, deactivateChat } from "../../db/repos/chats.js";
import {
  HostedOnboardingRateLimitError,
  ensureUserWithOnboardingLimit,
} from "../../abuse/hostedOnboarding.js";
import { getLogger } from "../../utils/logger.js";
import { localeFromTelegram } from "../../i18n/index.js";

export async function chatMemberHandler(ctx: Context): Promise<void> {
  const update = ctx.myChatMember;
  if (!update) return;

  const chat = ctx.chat;
  if (!chat || chat.type === "private") return; // DM registration is done via /start

  const db = getDb();
  const chatId = BigInt(chat.id);
  const status = update.new_chat_member.status;
  const title = "title" in chat ? chat.title : "Unknown";

  if (status === "member" || status === "administrator") {
    if (loadConfig().appMode === "hosted") {
      // Ensure the inviting user has a hosted user row (rate-limited). If we cannot
      // resolve them, still register the chat — Telegram membership is the source
      // of truth for chat-level permissions.
      await ensureHostedActingUser(ctx);
    }
    await upsertChat(db, { id: chatId, title, type: chat.type });
    getLogger().info({ chatId: chatId.toString(), title }, "Bot added to chat");
  } else if (status === "left" || status === "kicked") {
    await deactivateChat(db, chatId);
    getLogger().info({ chatId: chatId.toString() }, "Bot removed from chat");
  }
}

async function ensureHostedActingUser(ctx: Context): Promise<void> {
  if (loadConfig().appMode !== "hosted" || !ctx.from) return;

  const db = getDb();
  try {
    await ensureUserWithOnboardingLimit(db, {
      id: BigInt(ctx.from.id),
      username: ctx.from.username ?? null,
      locale: localeFromTelegram(ctx.from.language_code),
    });
  } catch (err: unknown) {
    if (err instanceof HostedOnboardingRateLimitError) return;
    throw err;
  }
}
