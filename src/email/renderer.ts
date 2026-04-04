import type { ParsedEmail } from "./types.js";
import { sanitizeTelegramHtml, stripHtml } from "../utils/telegramHtml.js";

const MAX_LEN = 4096;
const MAX_BODY_LEN = 3800;
const TRUNCATION_NOTICE = "\n[... truncated]";

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
  const header = `From: ${from}\nTo: ${aliasFullAddress}\nSubject: ${subject}`;

  const rawBody = extractBody(email, mode);
  const body = truncateBody(rawBody);

  const parts = [header, body];

  if (attachmentLinks.length > 0) {
    const links = attachmentLinks.map((a) => `${a.filename}: ${a.url}`).join("\n");
    parts.push(`Attachments:\n${links}`);
  }

  const full = parts.filter(Boolean).join("\n\n");

  if (full.length <= MAX_LEN) return full;

  return full.slice(0, MAX_LEN - TRUNCATION_NOTICE.length) + TRUNCATION_NOTICE;
}

function truncateBody(body: string): string {
  if (body.length <= MAX_BODY_LEN) return body;
  return body.slice(0, MAX_BODY_LEN - TRUNCATION_NOTICE.length) + TRUNCATION_NOTICE;
}

function extractBody(email: ParsedEmail, mode: RenderMode): string {
  if (mode === "html") {
    if (email.htmlBody) {
      return sanitizeTelegramHtml(email.htmlBody);
    }
    return email.textBody ?? "";
  }

  // plaintext and markdown: prefer text, fall back to stripped HTML
  if (email.textBody) {
    return email.textBody;
  }
  if (email.htmlBody) {
    return stripHtml(email.htmlBody);
  }
  return "";
}
