import type { Context } from "grammy";
import { getDb } from "../../db/client.js";
import { listAliasesByChat } from "../../db/repos/aliases.js";

export async function listemailHandler(ctx: Context): Promise<void> {
  const chatId = BigInt(ctx.chat!.id);
  const aliases = await listAliasesByChat(getDb(), chatId);

  if (aliases.length === 0) {
    await ctx.reply("📭 No aliases for this chat.\n\nCreate one with /newemail <name>");
    return;
  }

  const statusIcon = (s: string) => (s === "active" ? "✅" : s === "paused" ? "⏸" : "🗑");
  const lines = aliases.map(
    (a) => `${statusIcon(a.status)} <code>${a.fullAddress}</code> [${a.renderMode}]`,
  );

  await ctx.reply(`📬 Aliases for this chat (${aliases.length}):\n\n${lines.join("\n")}`, {
    parse_mode: "HTML",
  });
}
