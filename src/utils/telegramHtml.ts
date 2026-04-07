import sanitizeHtml from "sanitize-html";

const TELEGRAM_ALLOWED_TAGS = [
  "b",
  "strong",
  "i",
  "em",
  "u",
  "ins",
  "s",
  "strike",
  "del",
  "code",
  "pre",
  "a",
];

export function sanitizeTelegramHtml(html: string): string {
  return sanitizeHtml(normalizeTelegramHtmlInput(html), {
    allowedTags: TELEGRAM_ALLOWED_TAGS,
    allowedAttributes: { a: ["href"] },
    exclusiveFilter: (frame) => frame.tag === "script" || frame.tag === "style",
  });
}

export function stripHtml(html: string): string {
  return sanitizeHtml(normalizeTelegramHtmlInput(html), {
    allowedTags: [],
    allowedAttributes: {},
    exclusiveFilter: (frame) => frame.tag === "script" || frame.tag === "style",
  });
}

function normalizeTelegramHtmlInput(html: string): string {
  return html
    .replace(/\r\n/g, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n• ")
    .replace(/<\/li>/gi, "")
    .replace(
      /<\/?(?:p|div|section|article|header|footer|blockquote|ul|ol|table|tr|h[1-6])\b[^>]*>/gi,
      "\n",
    )
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
