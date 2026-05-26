import { simpleParser } from "mailparser";
import { createHash } from "crypto";
import type { ParsedEmail, ParsedEmailAttachment } from "./types.js";

export async function parseEmail(raw: Buffer, rawSizeBytes: number): Promise<ParsedEmail> {
  const parsed = await simpleParser(raw);

  const fromAddr = parsed.from?.value[0];
  const envelopeFrom = fromAddr?.address ?? null;
  const headerFrom = parsed.from?.text ?? null;
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
    filename: att.filename ?? "attachment",
    contentType: att.contentType,
    sizeBytes: att.size ?? att.content.length,
    content: att.content,
    sha256: createHash("sha256").update(att.content).digest("hex"),
  }));

  return {
    messageId: parsed.messageId ?? null,
    subject: parsed.subject ?? null,
    envelopeFrom,
    headerFrom,
    headerFromEmail,
    headerFromDomain,
    textBody,
    htmlBody,
    bodySha256,
    attachments,
    rawSizeBytes,
  };
}
