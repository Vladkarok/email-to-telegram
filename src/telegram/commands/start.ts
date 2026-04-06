import { InlineKeyboard } from "grammy";
import type { Context } from "grammy";
import { getDb } from "../../db/client.js";
import { upsertChat } from "../../db/repos/chats.js";
import { sendChatSelectionMenu } from "../menu/chatMenu.js";

export async function startHandler(ctx: Context): Promise<void> {
  if (!ctx.from) return;

  if (ctx.chat?.type !== "private") {
    // In a group — redirect to DM
    const botUsername = ctx.me.username;
    const keyboard = new InlineKeyboard().url("💬 Open DM", `https://t.me/${botUsername}?start=hi`);
    await ctx.reply("Manage email aliases in our private chat 👇", {
      reply_markup: keyboard,
    });
    return;
  }

  // Register DM chat so it appears in selection menus
  const name = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ");
  await upsertChat(getDb(), { id: BigInt(ctx.chat.id), title: `🏠 ${name} (DM)`, type: "private" });

  await sendChatSelectionMenu(ctx, getDb(), { welcome: true });
}
