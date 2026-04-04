import type { ParsedEmail } from "./types.js";
import { sanitizeTelegramHtml, stripHtml } from "../utils/telegramHtml.js";

const MAX_LEN = 4096;
const TRUNCATION_NOTICE = "\n[... truncated]";
const SEPARATOR = "\n\n";

export interface AttachmentLink {
  filename: string;
  sizeBytes: number;
  url: string;
}

export type RenderMode = "plaintext" | "html" | "markdown";

export function renderEmail(
  email: ParsedEmail,
  mode: RenderMode,
  aliasFullAddress: string,
  attachmentLinks: AttachmentLink[],
): string {
  const from = email.headerFrom ?? email.envelopeFrom ?? "unknown";
  const subject = email.subject ?? "(no subject)";

  const header = buildHeader(mode, from, aliasFullAddress, subject);

  // Attachments section is built with mode-appropriate escaping so filenames
  // and URLs are safe in HTML / MarkdownV2 parse modes.
  const attachmentsSection = buildAttachmentsSection(attachmentLinks, mode);

  const fixedCost =
    header.length +
    SEPARATOR.length +
    (attachmentsSection ? SEPARATOR.length + attachmentsSection.length : 0);

  const bodyBudget = MAX_LEN - fixedCost;

  const rawBody = extractBody(email, mode);
  const body = truncateToBudget(rawBody, bodyBudget);

  const parts = [header, body];
  if (attachmentsSection) parts.push(attachmentsSection);

  // Safety clamp: if header + attachments alone exceed MAX_LEN (many attachments),
  // drop trailing attachment entries until the message fits.
  return clampToMaxLen(parts);
}

function buildAttachmentsSection(links: AttachmentLink[], mode: RenderMode): string {
  if (links.length === 0) return "";
  const items = links.map((a) => {
    if (mode === "html") {
      // Use anchor tags so filenames are HTML-safe and URLs are clickable.
      return `<a href="${a.url}">${escapeHtml(a.filename)}</a>`;
    }
    if (mode === "markdown") {
      // Inline link syntax: URL inside () only needs \ and ) escaped (tokens have neither).
      return `[${escapeMarkdownV2(a.filename)}](${a.url})`;
    }
    return `${a.filename}: ${a.url}`;
  });
  return "Attachments:\n" + items.join("\n");
}

function clampToMaxLen(parts: string[]): string {
  const joined = parts.join(SEPARATOR);
  if (joined.length <= MAX_LEN) return joined;

  // Drop trailing attachment entries one by one until the message fits.
  // parts = [header, body, attachmentsSection?]
  if (parts.length < 3) return joined.slice(0, MAX_LEN);

  const attLines = parts[2].split("\n"); // "Attachments:\nline1\nline2..."
  while (attLines.length > 1 && parts.join(SEPARATOR).length > MAX_LEN) {
    attLines.pop();
    parts[2] = attLines.join("\n");
  }

  const result = parts.join(SEPARATOR);
  // Last resort: if even the label line alone overflows, hard-slice.
  return result.length <= MAX_LEN ? result : result.slice(0, MAX_LEN);
}

function buildHeader(mode: RenderMode, from: string, to: string, subject: string): string {
  if (mode === "html") {
    const e = escapeHtml;
    return `From: ${e(from)}\nTo: ${e(to)}\nSubject: ${e(subject)}`;
  }
  if (mode === "markdown") {
    const e = escapeMarkdownV2;
    return `From: ${e(from)}\nTo: ${e(to)}\nSubject: ${e(subject)}`;
  }
  // plaintext — no parse_mode, no escaping needed
  return `From: ${from}\nTo: ${to}\nSubject: ${subject}`;
}

function extractBody(email: ParsedEmail, mode: RenderMode): string {
  if (mode === "html") {
    if (email.htmlBody) {
      return sanitizeTelegramHtml(email.htmlBody);
    }
    // Plain-text fallback must be HTML-escaped; raw text with < > & would be
    // parsed as tags or entity refs by Telegram's HTML parser.
    return escapeHtml(email.textBody ?? "");
  }

  if (mode === "markdown") {
    // All content must be MarkdownV2-escaped. Strip HTML if only htmlBody is present.
    const raw = email.textBody ?? (email.htmlBody ? stripHtml(email.htmlBody) : "");
    return escapeMarkdownV2(raw);
  }

  // plaintext — sent with no parse_mode, no escaping required
  if (email.textBody) return email.textBody;
  if (email.htmlBody) return stripHtml(email.htmlBody);
  return "";
}

function truncateToBudget(text: string, budget: number): string {
  if (budget <= 0) return TRUNCATION_NOTICE;
  if (text.length <= budget) return text;
  const cutLen = budget - TRUNCATION_NOTICE.length;
  if (cutLen <= 0) return TRUNCATION_NOTICE;
  return text.slice(0, cutLen) + TRUNCATION_NOTICE;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Telegram MarkdownV2 requires these characters to be escaped with a leading backslash.
// See https://core.telegram.org/bots/api#markdownv2-style
function escapeMarkdownV2(text: string): string {
  return text.replace(/[_*[\]()~`<>#+=|{}.!\\-]/g, "\\$&");
}
