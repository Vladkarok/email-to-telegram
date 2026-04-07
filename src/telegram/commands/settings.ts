import type { CommandContext, Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { getDb } from "../../db/client.js";
import type { EmailAddress } from "../../db/schema.js";
import {
  findAliasByIdAndChat,
  updateAliasBodyDedup,
  updateAliasRenderMode,
} from "../../db/repos/aliases.js";
import { canManageAlias } from "../authorization.js";
import {
  RENDER_MODES,
  bodyDedupGuidance,
  settingsHelpText,
  renderModeGuidance,
  type TelegramRenderMode,
} from "../renderModeGuidance.js";

export async function settingsHandler(ctx: CommandContext<Context>): Promise<void> {
  const parts = ctx.match.trim().split(/\s+/);
  const [localPart, setting, value] = parts;

  if (!localPart) {
    await ctx.reply(settingsUsageText(), { parse_mode: "HTML" });
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

  if (
    !ctx.from ||
    !(await canManageAlias(getDb(), ctx.api, ctx.from.id, alias.id, { fresh: true }))
  ) {
    await ctx.reply("⛔ Access denied.");
    return;
  }

  if (setting && RENDER_MODES.includes(setting as TelegramRenderMode) && !value) {
    await updateAliasRenderMode(getDb(), alias.id, setting as TelegramRenderMode);
    await ctx.reply(
      `✅ Render mode for <code>${alias.fullAddress}</code> set to <b>${setting}</b>.\n${renderModeGuidance(setting as TelegramRenderMode)}`,
      { parse_mode: "HTML" },
    );
    return;
  }

  if (setting === "dedup") {
    if (value !== "on" && value !== "off") {
      await ctx.reply(settingsUsageText(), { parse_mode: "HTML" });
      return;
    }
    const bodyDedupEnabled = value === "on";
    await updateAliasBodyDedup(getDb(), alias.id, bodyDedupEnabled);
    await ctx.reply(
      `✅ Body dedup for <code>${alias.fullAddress}</code> set to <b>${bodyDedupEnabled ? "on" : "off"}</b>.\n${bodyDedupGuidance(bodyDedupEnabled)}`,
      { parse_mode: "HTML" },
    );
    return;
  }

  if (setting) {
    await ctx.reply(settingsUsageText(), { parse_mode: "HTML" });
    return;
  }

  await ctx.reply(buildAliasSettingsText(alias), {
    parse_mode: "HTML",
    reply_markup: buildAliasSettingsKeyboard(alias),
  });
}

export function buildAliasSettingsText(
  alias: Pick<EmailAddress, "fullAddress" | "renderMode" | "bodyDedupEnabled">,
): string {
  return [
    `⚙️ Settings for <code>${escapeHtml(alias.fullAddress)}</code>`,
    `Render mode: <b>${alias.renderMode}</b>`,
    renderModeGuidance(alias.renderMode as TelegramRenderMode),
    "",
    `Body dedup: <b>${alias.bodyDedupEnabled ? "on" : "off"}</b>`,
    bodyDedupGuidance(alias.bodyDedupEnabled),
  ].join("\n");
}

export function buildAliasSettingsKeyboard(
  alias: Pick<EmailAddress, "id" | "renderMode" | "bodyDedupEnabled">,
  includeBack = false,
): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  for (const mode of RENDER_MODES) {
    const current = mode === alias.renderMode ? "✓ " : "";
    keyboard.text(`${current}${mode}`, `set_mode:${alias.id}:${mode}`);
  }

  keyboard
    .row()
    .text(`${alias.bodyDedupEnabled ? "✓" : "○"} Body Dedup`, `toggle_body_dedup:${alias.id}`);

  if (includeBack) {
    keyboard.row().text("⬅️ Back", `am:${alias.id}`);
  }

  return keyboard;
}

function settingsUsageText(): string {
  return [
    "Usage: /settings <alias-name> [plaintext|html|markdown]",
    "Usage: /settings <alias-name> dedup <on|off>",
    "",
    settingsHelpText(),
  ].join("\n");
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
