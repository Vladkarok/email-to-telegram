import type { Context } from "grammy";
import { getDb } from "../../db/client.js";
import { upsertChat, deactivateChat } from "../../db/repos/chats.js";
import { getLogger } from "../../utils/logger.js";

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
    await upsertChat(db, { id: chatId, title, type: chat.type });
    getLogger().info({ chatId: chatId.toString(), title }, "Bot added to chat");
  } else if (status === "left" || status === "kicked") {
    await deactivateChat(db, chatId);
    getLogger().info({ chatId: chatId.toString() }, "Bot removed from chat");
  }
}
