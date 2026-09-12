/**
 * Escapes for **element content** only. Deliberately leaves `"` alone: every
 * call site interpolates between tags, never inside a quoted attribute. Use
 * `escapeHtmlAttribute` for attribute values — putting the output of this
 * function in an `href="…"` would allow an attribute breakout.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/'/g, "&#39;");
}

export function escapeHtmlAttribute(text: string): string {
  return escapeHtml(text).replace(/"/g, "&quot;");
}
