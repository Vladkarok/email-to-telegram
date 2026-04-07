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
