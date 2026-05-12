import { DEFAULT_LOCALE, getMessages, type Locale } from "../i18n/index.js";

export const RENDER_MODES = ["plaintext", "html", "markdown"] as const;

export type TelegramRenderMode = (typeof RENDER_MODES)[number];

export function renderModeGuidance(mode: TelegramRenderMode): string {
  if (mode === "plaintext") {
    return "Plaintext: send literal text exactly as typed.";
  }

  if (mode === "html") {
    return "HTML: use your mail client's rich-text toolbar. Do not type raw HTML tags.";
  }

  return "Markdown: type markdown syntax literally. Do not use the rich-text toolbar.";
}

export function renderModeHelpText(locale: Locale = DEFAULT_LOCALE): string {
  return getMessages(locale).renderGuidance.renderModeHelp;
}

export function bodyDedupGuidance(enabled: boolean): string {
  if (enabled) {
    return "Body dedup: on. Future emails with the same body may be suppressed for this alias. Message-ID duplicates are still blocked when that header is present.";
  }

  return "Body dedup: off. Repeated alerts with the same body still deliver. Recommended for alarm aliases. Message-ID duplicates are still blocked when that header is present.";
}

export function bodyDedupHelpText(locale: Locale = DEFAULT_LOCALE): string {
  return getMessages(locale).renderGuidance.bodyDedupHelp;
}

export function privacyModeGuidance(enabled: boolean): string {
  if (enabled) {
    return "Privacy mode: on. Telegram gets a minimal alert and a browser view link. The email body stays out of Telegram, and attachment downloads are generated only after the browser view is opened.";
  }

  return "Privacy mode: off. Telegram receives the rendered email body and any attachment handling allowed by the alias settings.";
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
