import { DEFAULT_LOCALE, getMessages, type Locale } from "../i18n/index.js";

export const RENDER_MODES = ["plaintext", "html", "markdown"] as const;

export type TelegramRenderMode = (typeof RENDER_MODES)[number];

export function renderModeGuidance(
  mode: TelegramRenderMode,
  locale: Locale = DEFAULT_LOCALE,
): string {
  const messages = getMessages(locale);
  if (mode === "plaintext") return messages.renderGuidance.plaintextGuidance;
  if (mode === "html") return messages.renderGuidance.htmlGuidance;
  return messages.renderGuidance.markdownGuidance;
}

export function renderModeHelpText(locale: Locale = DEFAULT_LOCALE): string {
  return getMessages(locale).renderGuidance.renderModeHelp;
}

export function bodyDedupGuidance(enabled: boolean, locale: Locale = DEFAULT_LOCALE): string {
  const messages = getMessages(locale);
  return enabled ? messages.renderGuidance.bodyDedupOn : messages.renderGuidance.bodyDedupOff;
}

export function bodyDedupHelpText(locale: Locale = DEFAULT_LOCALE): string {
  return getMessages(locale).renderGuidance.bodyDedupHelp;
}

export function privacyModeGuidance(enabled: boolean, locale: Locale = DEFAULT_LOCALE): string {
  const messages = getMessages(locale);
  return enabled ? messages.renderGuidance.privacyOn : messages.renderGuidance.privacyOff;
}

export function privacyModeHelpText(locale: Locale = DEFAULT_LOCALE): string {
  return getMessages(locale).renderGuidance.privacyModeHelp;
}

export function safetyDisclaimerText(locale: Locale = DEFAULT_LOCALE): string {
  return getMessages(locale).renderGuidance.safety;
}

export function settingsHelpText(locale: Locale = DEFAULT_LOCALE): string {
  return [
    renderModeHelpText(locale),
    "",
    bodyDedupHelpText(locale),
    "",
    privacyModeHelpText(locale),
  ].join("\n");
}
