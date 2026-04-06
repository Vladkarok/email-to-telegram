import type { CommandContext, Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { getDb } from "../../db/client.js";
import { findAliasByIdAndChat, updateAliasRenderMode } from "../../db/repos/aliases.js";
import { canManageAlias } from "../authorization.js";

const RENDER_MODES = ["plaintext", "html", "markdown"] as const;

export async function settingsHandler(ctx: CommandContext<Context>): Promise<void> {
  const parts = ctx.match.trim().split(/\s+/);
  const [localPart, newMode] = parts;

  if (!localPart) {
    await ctx.reply("Usage: /settings <alias-name> [plaintext|html|markdown]");
    return;
  }

  const chatId = BigInt(ctx.chat.id);
  const alias = await findAliasByIdAndChat(getDb(), localPart, chatId);

  if (!alias) {
    await ctx.reply(`❌ Alias <code>${localPart}</code> not found in this chat.`, {
      parse_mode: "HTML",
    });
    return;
  }

  if (!ctx.from || !(await canManageAlias(getDb(), ctx.api, ctx.from.id, alias.id))) {
    await ctx.reply("⛔ Access denied.");
    return;
  }

  // If mode is provided directly, apply it
  if (newMode && RENDER_MODES.includes(newMode as (typeof RENDER_MODES)[number])) {
    await updateAliasRenderMode(getDb(), alias.id, newMode as (typeof RENDER_MODES)[number]);
    await ctx.reply(
      `✅ Render mode for <code>${alias.fullAddress}</code> set to <b>${newMode}</b>.`,
      { parse_mode: "HTML" },
    );
    return;
  }

  // Otherwise show inline keyboard
  const keyboard = new InlineKeyboard();
  for (const mode of RENDER_MODES) {
    const current = mode === alias.renderMode ? "✓ " : "";
    keyboard.text(`${current}${mode}`, `set_mode:${alias.id}:${mode}`);
  }

  await ctx.reply(
    `⚙️ Render mode for <code>${alias.fullAddress}</code>\nCurrent: <b>${alias.renderMode}</b>\n\nSelect new mode:`,
    { parse_mode: "HTML", reply_markup: keyboard },
  );
}
