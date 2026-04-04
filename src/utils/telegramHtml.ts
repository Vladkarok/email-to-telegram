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
  return sanitizeHtml(html, {
    allowedTags: TELEGRAM_ALLOWED_TAGS,
    allowedAttributes: { a: ["href"] },
    exclusiveFilter: (frame) => frame.tag === "script" || frame.tag === "style",
  });
}

export function stripHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: [],
    allowedAttributes: {},
    exclusiveFilter: (frame) => frame.tag === "script" || frame.tag === "style",
  });
}
