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

  // Attachments section is always included in full — never truncated.
  // Reserve its space before computing the body budget.
  const attachmentsSection =
    attachmentLinks.length > 0
      ? "Attachments:\n" + attachmentLinks.map((a) => `${a.filename}: ${a.url}`).join("\n")
      : "";

  const fixedCost =
    header.length +
    SEPARATOR.length +
    (attachmentsSection ? SEPARATOR.length + attachmentsSection.length : 0);

  const bodyBudget = MAX_LEN - fixedCost;

  const rawBody = extractBody(email, mode);
  const body = truncateToBudget(rawBody, bodyBudget);

  const parts = [header, body];
  if (attachmentsSection) parts.push(attachmentsSection);

  return parts.join(SEPARATOR);
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
