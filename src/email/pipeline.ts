import { randomUUID } from "crypto";
import { join } from "path";
import type { Api } from "grammy";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../db/schema.js";
import { parseEmail } from "./parser.js";
import { cleanEmailBody } from "./cleaner.js";
import { renderEmail, type AttachmentLink } from "./renderer.js";
import { isDuplicate } from "./dedup.js";
import { findAliasByLocalPart } from "../db/repos/aliases.js";
import { checkAllowRule } from "../db/repos/allowRules.js";
import { createDeliveryLog, updateDeliveryLogStatus } from "../db/repos/deliveryLogs.js";
import { createAttachment } from "../db/repos/attachments.js";
import { createAttachmentLink } from "../db/repos/attachmentLinks.js";
import { writeAttachment } from "../storage/disk.js";
import { generateDownloadToken } from "../utils/tokens.js";
import { getLogger } from "../utils/logger.js";

type Db = NodePgDatabase<typeof schema>;

export interface PipelineInput {
  rawEmail: Buffer;
  localPart: string;
  /**
   * SMTP envelope sender (MAIL FROM) as received by the Cloudflare Worker via message.from.
   * This is the authoritative value for allow-rule enforcement — it cannot be spoofed by
   * the email body. When present it takes precedence over the From: header parsed from MIME.
   */
  envelopeFrom?: string;
  /** Public base URL for building attachment download links, e.g. https://mail.example.com */
  publicBaseUrl: string;
  /** Directory where attachment files are stored */
  attachmentDir: string;
  /** Attachment download link TTL in hours */
  attachmentTtlHours: number;
}

export interface PipelineResult {
  ok: boolean;
  reason?: string;
}

export async function processInboundEmail(
  db: Db,
  api: Api | null,
  input: PipelineInput,
): Promise<PipelineResult> {
  const log = getLogger();
  const { rawEmail, localPart, publicBaseUrl, attachmentDir, attachmentTtlHours } = input;

  // 1. Resolve alias
  const alias = await findAliasByLocalPart(db, localPart);
  if (!alias || alias.status !== "active") {
    return { ok: false, reason: "alias_not_found" };
  }

  // 2. Parse email
  const parsed = await parseEmail(rawEmail, rawEmail.length);

  // 3. Allow-rule check — use the SMTP envelope sender from the HTTP header when available
  // (it comes from Cloudflare's message.from and cannot be spoofed via email headers),
  // falling back to the parsed From: address only when the worker doesn't supply it.
  const envelopeFrom = input.envelopeFrom ?? parsed.envelopeFrom;
  if (envelopeFrom) {
    const allowed = await checkAllowRule(db, alias.id, envelopeFrom);
    if (!allowed) {
      return { ok: false, reason: "sender_not_allowed" };
    }
  }

  // 4. Dedup
  const dup = await isDuplicate(db, {
    messageId: parsed.messageId,
    bodySha256: parsed.bodySha256,
    aliasId: alias.id,
  });
  if (dup) {
    return { ok: false, reason: "duplicate" };
  }

  // 5. Create delivery log
  const deliveryLog = await createDeliveryLog(db, {
    emailAddressId: alias.id,
    messageIdHeader: parsed.messageId,
    bodySha256: parsed.bodySha256,
    envelopeFrom: parsed.envelopeFrom,
    headerFrom: parsed.headerFrom,
    subject: parsed.subject,
    rawSizeBytes: parsed.rawSizeBytes,
    hasAttachments: parsed.attachments.length > 0,
    finalStatus: "received",
  });

  // 6. Clean body
  if (parsed.textBody) {
    parsed.textBody = cleanEmailBody(parsed.textBody);
  }

  // 7. Save attachments and generate download links
  const attachmentLinks: AttachmentLink[] = [];
  for (const att of parsed.attachments) {
    try {
      const fileId = randomUUID();
      const storagePath = join(attachmentDir, deliveryLog.id, `${fileId}.bin`);
      await writeAttachment(storagePath, att.content);

      const dbAtt = await createAttachment(db, {
        deliveryLogId: deliveryLog.id,
        originalFilename: att.filename,
        contentType: att.contentType,
        sizeBytes: att.sizeBytes,
        sha256: att.sha256,
        storagePath,
      });

      const { token, expiresAt } = generateDownloadToken(dbAtt.id, attachmentTtlHours);
      await createAttachmentLink(db, dbAtt.id, token, expiresAt);

      attachmentLinks.push({
        filename: att.filename,
        sizeBytes: att.sizeBytes,
        url: `${publicBaseUrl}/dl/${token}`,
      });
    } catch (err: unknown) {
      log.error({ err, filename: att.filename }, "failed to store attachment");
    }
  }

  // 8. Render
  const renderMode = (alias.renderMode ?? "plaintext") as "plaintext" | "html" | "markdown";
  const text = renderEmail(parsed, renderMode, alias.fullAddress, attachmentLinks);

  // 9. Send — parse_mode depends on render mode; plaintext uses none (avoids HTML metachar issues)
  if (api) {
    const { sendTelegramMessage } = await import("../telegram/sender.js");
    const parseMode =
      renderMode === "html" ? "HTML" : renderMode === "markdown" ? "MarkdownV2" : undefined;

    const result = await sendTelegramMessage(api, {
      chatId: alias.chatId,
      threadId: alias.messageThreadId ?? null,
      text,
      parseMode,
    });

    const finalStatus = result.ok ? "delivered" : "failed";
    await updateDeliveryLogStatus(db, deliveryLog.id, finalStatus);

    if (!result.ok) {
      log.error({ deliveryLogId: deliveryLog.id, error: result.error }, "delivery failed");
      return { ok: false, reason: "send_failed" };
    }
  }

  return { ok: true };
}
