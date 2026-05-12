import type { Context } from "grammy";
import { loadConfig } from "../../config.js";
import { getDb } from "../../db/client.js";
import { upsertChat, deactivateChat } from "../../db/repos/chats.js";
import { upsertUser } from "../../db/repos/users.js";
import {
  HostedOnboardingRateLimitError,
  ensurePersonalOrganizationForUserWithOnboardingLimit,
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
    const organizationId = await resolveHostedOrganizationId(ctx);
    if (loadConfig().appMode === "hosted" && !organizationId) {
      getLogger().warn({ chatId: chatId.toString() }, "hosted chat registration skipped");
      return;
    }
    await upsertChat(db, { id: chatId, organizationId, title, type: chat.type });
    getLogger().info({ chatId: chatId.toString(), title }, "Bot added to chat");
  } else if (status === "left" || status === "kicked") {
    await deactivateChat(db, chatId);
    getLogger().info({ chatId: chatId.toString() }, "Bot removed from chat");
  }
}

async function resolveHostedOrganizationId(ctx: Context): Promise<string | null> {
  if (loadConfig().appMode !== "hosted" || !ctx.from) return null;

  const db = getDb();
  const user = await upsertUser(db, {
    id: BigInt(ctx.from.id),
    username: ctx.from.username ?? null,
    locale: localeFromTelegram(ctx.from.language_code),
  });
  let organization;
  try {
    organization = await ensurePersonalOrganizationForUserWithOnboardingLimit(db, user);
  } catch (err: unknown) {
    if (err instanceof HostedOnboardingRateLimitError) {
      return null;
    }
    throw err;
  }
  return organization.id;
}
