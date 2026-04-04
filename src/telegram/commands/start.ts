import type { Context } from "grammy";

export async function startHandler(ctx: Context): Promise<void> {
  await ctx.reply(
    `👋 Welcome to <b>Email-to-Telegram</b>!\n\nI forward emails to Telegram chats.\n\n<b>Getting started:</b>\n1. Add me to a group or use me in this DM\n2. Create an alias: <code>/newemail alerts</code>\n3. Add allowed senders: <code>/allow add alerts-xxxx github.com</code>\n4. Send an email to the alias — it appears here!\n\nType /help to see all commands.`,
    { parse_mode: "HTML" },
  );
}
