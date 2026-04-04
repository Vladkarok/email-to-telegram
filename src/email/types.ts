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
  bodySha256: string;
  attachments: ParsedEmailAttachment[];
  rawSizeBytes: number;
}
