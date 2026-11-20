import { simpleParser } from "mailparser";
import { createHash } from "crypto";
import { formatAddressDisplay } from "./addressDisplay.js";
import type { ParsedEmail, ParsedEmailAttachment } from "./types.js";

export async function parseEmail(raw: Buffer, rawSizeBytes: number): Promise<ParsedEmail> {
  const parsed = await simpleParser(raw);

  const fromAddr = parsed.from?.value[0];
  const envelopeFrom = fromAddr?.address ?? null;
  const headerFrom = parsed.from?.text ?? null;
  const headerFromDisplay = parsed.from ? formatAddressDisplay(parsed.from.value) : null;
  const headerFromEmail =
    parsed.from?.value.length === 1 ? (parsed.from.value[0]?.address?.toLowerCase() ?? null) : null;
  const headerFromDomain = headerFromEmail?.split("@")[1] ?? null;

  const textBody = parsed.text ?? null;
  const htmlBody = parsed.html !== false ? parsed.html || null : null;

  const bodyContent = textBody ?? htmlBody ?? null;
  const bodySha256 =
    bodyContent !== null && bodyContent.length > 0
      ? createHash("sha256").update(bodyContent).digest("hex")
      : null;

  const attachments: ParsedEmailAttachment[] = (parsed.attachments ?? []).map((att) => ({
    filename: sanitizeAttachmentFilename(att.filename ?? "attachment"),
    contentType: sanitizeAttachmentContentType(att.contentType),
    sizeBytes: att.size ?? att.content.length,
    content: att.content,
    sha256: createHash("sha256").update(att.content).digest("hex"),
  }));

  return {
    messageId: parsed.messageId ?? null,
    subject: parsed.subject ?? null,
    envelopeFrom,
    headerFrom,
    headerFromDisplay,
    headerFromEmail,
    headerFromDomain,
    textBody,
    htmlBody,
    bodySha256,
    attachments,
    rawSizeBytes,
  };
}

// attachments.original_filename is varchar(255) and content_type varchar(127).
// Postgres counts characters (code points) and rejects NUL in text, so an
// unbounded value from the sender would fail the insert.
const MAX_ATTACHMENT_FILENAME_CHARS = 255;
const MAX_ATTACHMENT_CONTENT_TYPE_CHARS = 127;
// Longest extension (dot included) worth keeping when a filename is cut.
const MAX_KEPT_EXTENSION_CHARS = 16;

function stripNul(value: string): string {
  return value.replaceAll("\u0000", "");
}

// Array.from splits by code point, so a surrogate pair is never cut in half.
function truncateCodePoints(value: string, max: number): string {
  if (value.length <= max) return value;
  const codePoints = Array.from(value);
  return codePoints.length <= max ? value : codePoints.slice(0, max).join("");
}

export function sanitizeAttachmentFilename(filename: string): string {
  const cleaned = stripNul(filename);
  // Only NUL bytes: keep the fallback name rather than an empty one.
  if (cleaned === "" && filename !== "") return "attachment";
  const truncated = truncateCodePoints(cleaned, MAX_ATTACHMENT_FILENAME_CHARS);
  if (truncated === cleaned) return cleaned;

  const dot = cleaned.lastIndexOf(".");
  if (dot <= 0) return truncated;
  const extension = Array.from(cleaned.slice(dot));
  if (extension.length < 2 || extension.length > MAX_KEPT_EXTENSION_CHARS) return truncated;
  const stem = truncateCodePoints(
    cleaned.slice(0, dot),
    MAX_ATTACHMENT_FILENAME_CHARS - extension.length,
  );
  return stem + extension.join("");
}

export function sanitizeAttachmentContentType(contentType: string): string {
  return truncateCodePoints(stripNul(contentType), MAX_ATTACHMENT_CONTENT_TYPE_CHARS);
}
