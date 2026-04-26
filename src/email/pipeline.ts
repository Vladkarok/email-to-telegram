import { randomUUID } from "crypto";
import { join } from "path";
import type { Api } from "grammy";
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../db/schema.js";
import type { EmailAddress, DeliveryLog } from "../db/schema.js";
import { parseEmail } from "./parser.js";
import { cleanEmailBody } from "./cleaner.js";
import {
  renderEmail,
  renderAttachmentFallback,
  renderPrivacyAlert,
  parseModeForRenderMode,
  type AttachmentLink,
} from "./renderer.js";
import { isImageContentType } from "./imageTypes.js";
import type { PhotoItem } from "../telegram/sender.js";
import { isDuplicate } from "./dedup.js";
import { findAliasByLocalPart } from "../db/repos/aliases.js";
import { checkAllowRule } from "../db/repos/allowRules.js";
import {
  countRecentDeliveriesByAlias,
  createDeliveryLog,
  updateDeliveryLogStatus,
} from "../db/repos/deliveryLogs.js";
import { insertDeliveryAttempt } from "../db/repos/deliveryAttempts.js";
import { createAttachment } from "../db/repos/attachments.js";
import { createAttachmentLink } from "../db/repos/attachmentLinks.js";
import { writeAttachment } from "../storage/disk.js";
import { generateDownloadToken } from "../utils/tokens.js";
import { getLogger } from "../utils/logger.js";
import { createPrivacyViewUrl } from "./privacy.js";
import type { StorageEncryptionMetadata } from "../security/encryption.js";
import { prepareDeliveryLogMetadataWrite } from "../security/deliveryLogMetadata.js";
import { checkInboundLimit } from "../billing/limits.js";
import { incrementOrganizationUsageMonth, usageMonthForDate } from "../db/repos/usage.js";

type Db = NodePgDatabase<typeof schema>;

export interface PipelineInput {
  rawEmail: Buffer;
  /** Path where the raw email was persisted on disk (for retry). */
  rawEmailPath?: string;
  localPart: string;
  /** HTTP request ID for correlating pipeline log entries to an inbound request. */
  correlationId?: string;
  /**
   * SMTP envelope sender (MAIL FROM) as received by the Cloudflare Worker via message.from.
   * This is the authoritative value for allow-rule enforcement — it cannot be spoofed by
   * the email body. When present it takes precedence over the From: header parsed from MIME.
   */
  envelopeFrom?: string;
  /** Public base URL for building attachment download links, e.g. https://mail.example.com */
  publicBaseUrl: string;
  /** Encryption metadata for the persisted raw email file, if one exists. */
  rawEmailEncryption?: StorageEncryptionMetadata;
  /** Directory where attachment files are stored */
  attachmentDir: string;
  /** Attachment download link TTL in hours */
  attachmentTtlHours: number;
  /** Raw email retention window in hours; privacy-mode links must not outlive it. */
  rawEmailTtlHours: number;
}

export interface PipelineResult {
  ok: boolean;
  reason?: string;
}

export interface QueuedInboundEmail {
  alias: EmailAddress;
  parsed: Awaited<ReturnType<typeof parseEmail>>;
  deliveryLog: DeliveryLog;
  envelopeFrom: string | null;
  publicBaseUrl: string;
  attachmentDir: string;
  attachmentTtlHours: number;
  rawEmailTtlHours: number;
  correlationId?: string;
}

export type QueueInboundResult =
  | { queued: true; job: QueuedInboundEmail }
  | { queued: false; result: PipelineResult };

interface StoredImageAttachment extends PhotoItem {
  attachmentId: string;
  sizeBytes: number;
}

function getPipelineLogger(correlationId?: string) {
  return correlationId ? getLogger().child({ correlationId }) : getLogger();
}

export async function queueInboundEmail(db: Db, input: PipelineInput): Promise<QueueInboundResult> {
  const {
    rawEmail,
    localPart,
    publicBaseUrl,
    attachmentDir,
    attachmentTtlHours,
    rawEmailTtlHours,
  } = input;

  // 1. Resolve alias
  const alias = await findAliasByLocalPart(db, localPart);
  if (!alias || alias.status !== "active") {
    return { queued: false, result: { ok: false, reason: "alias_not_found" } };
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
      return { queued: false, result: { ok: false, reason: "sender_not_allowed" } };
    }
  }

  const receivedSince = new Date(Date.now() - 60 * 60 * 1000);
  const queueResult = await db.transaction(async (tx) => {
    if (alias.organizationId) {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${alias.organizationId}))`);
    }

    // Serialize per-alias queue decisions so the hourly cap cannot be exceeded
    // by concurrent requests racing between COUNT(*) and INSERT.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${alias.id}))`);

    const inboundLimit = await checkInboundLimit(tx as Db, alias.organizationId, rawEmail.length);
    if (!inboundLimit.ok) {
      return { kind: "inbound_limit" as const, limit: inboundLimit };
    }

    const dup = await isDuplicate(tx as Db, {
      messageId: parsed.messageId,
      bodySha256: parsed.bodySha256,
      aliasId: alias.id,
      bodyDedupEnabled: alias.bodyDedupEnabled ?? false,
    });
    if (dup) {
      return { kind: "duplicate" as const };
    }

    const recentDeliveries = await countRecentDeliveriesByAlias(tx as Db, alias.id, receivedSince);
    if (recentDeliveries >= alias.maxEmailsHour) {
      return { kind: "rate_limited" as const };
    }

    const deliveryLogId = randomUUID();
    const deliveryLogMetadata = await prepareDeliveryLogMetadataWrite(deliveryLogId, {
      envelopeFrom,
      headerFrom: parsed.headerFrom,
      subject: parsed.subject,
    });

    // 5. Create delivery log — null means a concurrent pipeline beat us (race dedup)
    const deliveryLog = await createDeliveryLog(tx as Db, {
      id: deliveryLogId,
      emailAddressId: alias.id,
      organizationId: alias.organizationId,
      messageIdHeader: parsed.messageId,
      bodySha256: parsed.bodySha256,
      bodyDedupApplied: alias.bodyDedupEnabled ?? false,
      envelopeFrom: deliveryLogMetadata.envelopeFrom,
      headerFrom: deliveryLogMetadata.headerFrom,
      subject: deliveryLogMetadata.subject,
      metadataCiphertext: deliveryLogMetadata.metadataCiphertext,
      metadataEncryptionMode: deliveryLogMetadata.metadataEncryptionMode,
      metadataWrappedDek: deliveryLogMetadata.metadataWrappedDek,
      metadataKekKeyId: deliveryLogMetadata.metadataKekKeyId,
      metadataEncryptedAt: deliveryLogMetadata.metadataEncryptedAt,
      rawSizeBytes: parsed.rawSizeBytes,
      rawEmailPath: input.rawEmailPath ?? null,
      rawEmailEncryptionMode: input.rawEmailEncryption?.encryptionMode ?? "none",
      rawEmailWrappedDek: input.rawEmailEncryption?.wrappedDek ?? null,
      rawEmailKekKeyId: input.rawEmailEncryption?.kekKeyId ?? null,
      rawEmailEncryptedAt: input.rawEmailEncryption?.encryptedAt ?? null,
      hasAttachments: parsed.attachments.length > 0,
      finalStatus: "received",
    });
    if (!deliveryLog) {
      return { kind: "duplicate" as const };
    }

    if (alias.organizationId) {
      await incrementOrganizationUsageMonth(tx as Db, {
        organizationId: alias.organizationId,
        month: usageMonthForDate(),
        deliveredCount: 1,
      });
    }

    return { kind: "queued" as const, deliveryLog };
  });

  if (queueResult.kind === "duplicate") {
    return { queued: false, result: { ok: false, reason: "duplicate" } };
  }

  if (queueResult.kind === "rate_limited") {
    return { queued: false, result: { ok: false, reason: "rate_limited" } };
  }

  if (queueResult.kind === "inbound_limit") {
    return {
      queued: false,
      result: { ok: false, reason: queueResult.limit.code },
    };
  }

  return {
    queued: true,
    job: {
      alias,
      parsed,
      deliveryLog: queueResult.deliveryLog,
      envelopeFrom,
      publicBaseUrl,
      attachmentDir,
      attachmentTtlHours,
      rawEmailTtlHours,
      correlationId: input.correlationId,
    },
  };
}

export async function deliverQueuedEmail(
  db: Db,
  api: Api | null,
  job: QueuedInboundEmail,
): Promise<PipelineResult> {
  const log = getPipelineLogger(job.correlationId);
  const { alias, deliveryLog, publicBaseUrl, attachmentDir, attachmentTtlHours, rawEmailTtlHours } =
    job;
  const privacyMode = alias.privacyModeEnabled ?? false;
  const parsed = {
    ...job.parsed,
    attachments: [...job.parsed.attachments],
  };

  try {
    await updateDeliveryLogStatus(db, deliveryLog.id, "processing");

    // 6. Clean body
    if (parsed.textBody) {
      parsed.textBody = cleanEmailBody(parsed.textBody);
    }

    // 7. Save attachments — images go to Telegram directly, non-images become download links
    const attachmentLinks: AttachmentLink[] = [];
    const imageAttachments: StoredImageAttachment[] = [];

    for (const att of parsed.attachments) {
      try {
        const attachmentId = randomUUID();
        const fileId = randomUUID();
        const storagePath = join(attachmentDir, deliveryLog.id, `${fileId}.bin`);
        const storageMetadata = await writeAttachment(storagePath, attachmentId, att.content);

        const dbAtt = await createAttachment(db, {
          id: attachmentId,
          deliveryLogId: deliveryLog.id,
          originalFilename: att.filename,
          contentType: att.contentType,
          sizeBytes: att.sizeBytes,
          sha256: att.sha256,
          storagePath,
          encryptionMode: storageMetadata.encryptionMode,
          wrappedDek: storageMetadata.wrappedDek,
          kekKeyId: storageMetadata.kekKeyId,
          encryptedAt: storageMetadata.encryptedAt,
        });

        if (isImageContentType(att.contentType)) {
          imageAttachments.push({
            id: dbAtt.id,
            storagePath,
            filename: att.filename,
            encryptionMode: dbAtt.encryptionMode,
            wrappedDek: dbAtt.wrappedDek,
            kekKeyId: dbAtt.kekKeyId,
            attachmentId: dbAtt.id,
            sizeBytes: att.sizeBytes,
          });
        } else if (!privacyMode) {
          const { token, expiresAt } = generateDownloadToken(dbAtt.id, attachmentTtlHours);
          await createAttachmentLink(db, dbAtt.id, token, expiresAt);
          attachmentLinks.push({
            filename: att.filename,
            sizeBytes: att.sizeBytes,
            url: `${publicBaseUrl}/dl/${token}`,
          });
        }
      } catch (err: unknown) {
        log.error({ err, filename: att.filename }, "failed to store attachment");
      }
    }

    // 8. Render
    const renderMode = (alias.renderMode ?? "plaintext") as "plaintext" | "html" | "markdown";
    const text = privacyMode
      ? await buildPrivacyModeMessage(db, deliveryLog, parsed, alias.fullAddress, publicBaseUrl, {
          rawEmailTtlHours,
        })
      : renderEmail(parsed, renderMode, alias.fullAddress, attachmentLinks);

    // 9. Send — parse_mode depends on render mode; plaintext uses none (avoids HTML metachar issues)
    if (api) {
      const { sendTelegramMessage, sendTelegramPhotos } = await import("../telegram/sender.js");
      const parseMode = privacyMode ? "HTML" : parseModeForRenderMode(renderMode);

      const result = await sendTelegramMessage(api, {
        chatId: alias.chatId,
        threadId: alias.messageThreadId ?? null,
        text,
        parseMode,
      });

      // Record attempt in DB
      await insertDeliveryAttempt(db, {
        deliveryLogId: deliveryLog.id,
        attemptNo: 1,
        targetChatId: alias.chatId,
        targetThreadId: alias.messageThreadId ?? null,
        telegramMessageId: result.telegramMessageId ? BigInt(result.telegramMessageId) : null,
        status: result.ok ? "succeeded" : "failed",
        errorText: result.error ?? null,
      });

      const finalStatus = result.ok ? "delivered" : "failed";
      await updateDeliveryLogStatus(db, deliveryLog.id, finalStatus);

      if (!result.ok) {
        log.error({ deliveryLogId: deliveryLog.id, error: result.error }, "delivery failed");
        return { ok: false, reason: "send_failed" };
      }

      // Send image attachments as Telegram photos (replied to the text message)
      if (!privacyMode && imageAttachments.length > 0) {
        try {
          const photoResult = await sendTelegramPhotos(api, {
            chatId: alias.chatId,
            threadId: alias.messageThreadId ?? null,
            replyToMessageId: result.telegramMessageId,
            photos: imageAttachments.map(
              ({ id, storagePath, filename, encryptionMode, wrappedDek, kekKeyId }) => ({
                id,
                storagePath,
                filename,
                encryptionMode,
                wrappedDek,
                kekKeyId,
              }),
            ),
          });

          if (photoResult.failedPhotos.length > 0) {
            const failedPaths = new Set(photoResult.failedPhotos.map((photo) => photo.storagePath));
            const fallbackLinks = await Promise.all(
              imageAttachments
                .filter((attachment) => failedPaths.has(attachment.storagePath))
                .map(async (attachment) => {
                  const { token, expiresAt } = generateDownloadToken(
                    attachment.attachmentId,
                    attachmentTtlHours,
                  );
                  await createAttachmentLink(db, attachment.attachmentId, token, expiresAt);
                  return {
                    filename: attachment.filename,
                    sizeBytes: attachment.sizeBytes,
                    url: `${publicBaseUrl}/dl/${token}`,
                  };
                }),
            );

            const fallbackResult = await sendTelegramMessage(api, {
              chatId: alias.chatId,
              threadId: alias.messageThreadId ?? null,
              text: renderAttachmentFallback(fallbackLinks),
            });

            if (!fallbackResult.ok) {
              log.error(
                { deliveryLogId: deliveryLog.id, error: fallbackResult.error },
                "image attachment fallback delivery failed",
              );
            }
          }
        } catch (err: unknown) {
          log.error(
            { err, deliveryLogId: deliveryLog.id },
            "image attachment secondary delivery failed",
          );
        }
      }
    }

    return { ok: true };
  } catch (err: unknown) {
    await updateDeliveryLogStatus(db, deliveryLog.id, "failed").catch((statusErr: unknown) => {
      log.error(
        { err: statusErr, deliveryLogId: deliveryLog.id },
        "failed to mark delivery failed",
      );
    });
    throw err;
  }
}

export async function processInboundEmail(
  db: Db,
  api: Api | null,
  input: PipelineInput,
): Promise<PipelineResult> {
  const queued = await queueInboundEmail(db, input);
  if (!queued.queued) {
    return queued.result;
  }
  return deliverQueuedEmail(db, api, queued.job);
}

async function buildPrivacyModeMessage(
  db: Db,
  deliveryLog: Pick<DeliveryLog, "id" | "rawEmailPath" | "receivedAt">,
  parsed: Awaited<ReturnType<typeof parseEmail>>,
  aliasFullAddress: string,
  publicBaseUrl: string,
  opts: { rawEmailTtlHours: number },
): Promise<string> {
  if (!deliveryLog.rawEmailPath) {
    throw new Error("privacy mode requires a durable raw email path");
  }

  const viewUrl = await createPrivacyViewUrl(
    db,
    deliveryLog.id,
    publicBaseUrl,
    new Date(deliveryLog.receivedAt.getTime() + opts.rawEmailTtlHours * 60 * 60 * 1000),
  );
  return renderPrivacyAlert(parsed, aliasFullAddress, viewUrl, parsed.attachments.length > 0);
}
