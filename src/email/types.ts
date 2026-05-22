export interface ParsedEmailAttachment {
  filename: string;
  contentType: string;
  sizeBytes: number;
  content: Buffer;
  sha256: string;
}

export interface ParsedEmail {
  messageId: string | null;
  subject: string | null;
  envelopeFrom: string | null;
  headerFrom: string | null;
  textBody: string | null;
  htmlBody: string | null;
  // null when the parsed email has no text/html body content (attachment-only
  // mail). Body-hash dedup is skipped in that case to avoid collapsing
  // unrelated emails that would all hash the empty string.
  bodySha256: string | null;
  attachments: ParsedEmailAttachment[];
  rawSizeBytes: number;
}
