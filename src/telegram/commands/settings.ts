import type { CommandContext, Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { getDb } from "../../db/client.js";
import type { EmailAddress } from "../../db/schema.js";
import {
  updateAliasBodyDedup,
  updateAliasPrivacyMode,
  updateAliasRenderMode,
} from "../../db/repos/aliases.js";
import { aliasResolutionError, resolveManageableAlias } from "../aliasResolver.js";
import { escapeHtml } from "../../utils/html.js";
import {
  RENDER_MODES,
  bodyDedupGuidance,
  privacyModeGuidance,
  settingsHelpText,
  renderModeGuidance,
  type TelegramRenderMode,
} from "../renderModeGuidance.js";
import {
  CB_SET_MODE,
  CB_TOGGLE_PRIVACY_MODE,
  CB_TOGGLE_BODY_DEDUP,
  CB_ALIAS_DETAIL,
} from "../callbacks.js";
import { DEFAULT_LOCALE, getMessages, resolveLocale, type Locale } from "../../i18n/index.js";

export async function settingsHandler(ctx: CommandContext<Context>): Promise<void> {
  if (!ctx.from) return;
  const parts = ctx.match.trim().split(/\s+/);
  const [aliasName, setting, value] = parts;
  const locale = await resolveLocale(ctx, getDb());
  const messages = getMessages(locale);

  if (!aliasName) {
    await ctx.reply(settingsUsageText(locale), { parse_mode: "HTML" });
    return;
  }

  const result = await resolveManageableAlias(
    getDb(),
    ctx.api,
    ctx.from.id,
    BigInt(ctx.chat.id),
    aliasName,
    ctx.chat.type,
  );

  if (!result.ok) {
    await ctx.reply(aliasResolutionError(result, aliasName, ctx.chat.type, locale), {
      parse_mode: "HTML",
    });
    return;
  }

  const alias = result.alias;

  if (setting && RENDER_MODES.includes(setting as TelegramRenderMode) && !value) {
    await updateAliasRenderMode(getDb(), alias.id, setting as TelegramRenderMode);
    await ctx.reply(
      messages.settingsCommand.renderModeSet(
        escapeHtml(alias.fullAddress),
        setting,
        renderModeGuidance(setting as TelegramRenderMode, locale),
      ),
      { parse_mode: "HTML" },
    );
    return;
  }

  if (setting === "dedup") {
    if (value !== "on" && value !== "off") {
      await ctx.reply(settingsUsageText(locale), { parse_mode: "HTML" });
      return;
    }
    const bodyDedupEnabled = value === "on";
    await updateAliasBodyDedup(getDb(), alias.id, bodyDedupEnabled);
    await ctx.reply(
      messages.settingsCommand.bodyDedupSet(
        escapeHtml(alias.fullAddress),
        bodyDedupEnabled,
        bodyDedupGuidance(bodyDedupEnabled, locale),
      ),
      { parse_mode: "HTML" },
    );
    return;
  }

  if (setting === "privacy") {
    if (value !== "on" && value !== "off") {
      await ctx.reply(settingsUsageText(locale), { parse_mode: "HTML" });
      return;
    }
    const privacyModeEnabled = value === "on";
    await updateAliasPrivacyMode(getDb(), alias.id, privacyModeEnabled);
    await ctx.reply(
      messages.settingsCommand.privacySet(
        escapeHtml(alias.fullAddress),
        privacyModeEnabled,
        privacyModeGuidance(privacyModeEnabled, locale),
      ),
      { parse_mode: "HTML" },
    );
    return;
  }

  if (setting) {
    await ctx.reply(settingsUsageText(locale), { parse_mode: "HTML" });
    return;
  }

  await ctx.reply(buildAliasSettingsText(alias, locale), {
    parse_mode: "HTML",
    reply_markup: buildAliasSettingsKeyboard(alias, false, locale),
  });
}

export function buildAliasSettingsText(
  alias: Pick<
    EmailAddress,
    "fullAddress" | "renderMode" | "bodyDedupEnabled" | "privacyModeEnabled"
  >,
  locale: Locale = DEFAULT_LOCALE,
): string {
  const messages = getMessages(locale);
  return [
    messages.settingsCommand.header(escapeHtml(alias.fullAddress)),
    messages.settingsCommand.renderModeLine(alias.renderMode),
    renderModeGuidance(alias.renderMode as TelegramRenderMode, locale),
    "",
    messages.settingsCommand.privacyLine(alias.privacyModeEnabled),
    privacyModeGuidance(alias.privacyModeEnabled, locale),
    "",
    messages.settingsCommand.bodyDedupLine(alias.bodyDedupEnabled),
    bodyDedupGuidance(alias.bodyDedupEnabled, locale),
  ].join("\n");
}

export function buildAliasSettingsKeyboard(
  alias: Pick<EmailAddress, "id" | "renderMode" | "bodyDedupEnabled" | "privacyModeEnabled">,
  includeBack = false,
  locale: Locale = DEFAULT_LOCALE,
): InlineKeyboard {
  const messages = getMessages(locale);
  const keyboard = new InlineKeyboard();

  for (const mode of RENDER_MODES) {
    const current = mode === alias.renderMode ? "✓ " : "";
    keyboard.text(`${current}${mode}`, CB_SET_MODE.build(alias.id, mode));
  }

  keyboard
    .row()
    .text(
      `${alias.privacyModeEnabled ? "✓" : "○"} ${messages.settingsCommand.privacyButton}`,
      CB_TOGGLE_PRIVACY_MODE.build(alias.id),
    )
    .text(
      `${alias.bodyDedupEnabled ? "✓" : "○"} ${messages.settingsCommand.bodyDedupButton}`,
      CB_TOGGLE_BODY_DEDUP.build(alias.id),
    );

  if (includeBack) {
    keyboard.row().text(messages.settingsCommand.backButton, CB_ALIAS_DETAIL.build(alias.id));
  }

  return keyboard;
}

function settingsUsageText(locale: Locale = DEFAULT_LOCALE): string {
  const messages = getMessages(locale);
  return [messages.settingsCommand.usage, "", settingsHelpText(locale)].join("\n");
}
