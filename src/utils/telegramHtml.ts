import { renderStructuredEmailHtml } from "./structuredEmailHtml.js";

/** Render untrusted email HTML into Telegram's classic HTML subset. */
export function sanitizeTelegramHtml(html: string): string {
  return renderStructuredEmailHtml(html).classicHtml;
}

/** Render untrusted email HTML as readable plain text. */
export function stripHtml(html: string): string {
  return renderStructuredEmailHtml(html).plainText;
}

export { renderStructuredEmailHtml } from "./structuredEmailHtml.js";
export type { StructuredHtmlResult, StructuredHtmlStats } from "./structuredEmailHtml.js";
