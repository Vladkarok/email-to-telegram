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

export function renderModeHelpText(): string {
  return [
    "<b>Render Modes</b>",
    "plaintext — sends literal text exactly as typed",
    "html — use Gmail or mail-client formatting buttons, not raw <code>&lt;b&gt;</code> tags",
    "markdown — type markdown syntax literally, not the rich-text toolbar",
  ].join("\n");
}

export function bodyDedupGuidance(enabled: boolean): string {
  if (enabled) {
    return "Body dedup: on. Future emails with the same body may be suppressed for this alias. Message-ID duplicates are still blocked when that header is present.";
  }

  return "Body dedup: off. Repeated alerts with the same body still deliver. Recommended for alarm aliases. Message-ID duplicates are still blocked when that header is present.";
}

export function bodyDedupHelpText(): string {
  return [
    "<b>Body Dedup</b>",
    "Message-ID duplicates are still blocked when that header is present",
    "new aliases default to body dedup off",
    "body dedup off — repeated alerts with the same body still deliver (recommended for alarm aliases)",
    "body dedup on — future emails with the same body may be suppressed for that alias",
  ].join("\n");
}

export function safetyDisclaimerText(): string {
  return [
    "<b>Safety Notes</b>",
    "Use this for operational alerts and convenience forwarding, not for secrets or regulated/confidential data.",
    "Mail content may be visible to the VPS operator, backups, Telegram chat members, and anyone with access to the bot or destination chat.",
    "Do not rely on Telegram forwarding as your only life-safety or paging channel.",
  ].join("\n");
}

export function settingsHelpText(): string {
  return [renderModeHelpText(), "", bodyDedupHelpText()].join("\n");
}
