/**
 * Inbound email delivery stage.
 *
 * Receives a pre-validated, pre-logged QueuedInboundEmail job and:
 *   1. Cleans the body
 *   2. Persists attachments (images → Telegram photos, others → download links)
 *   3. Renders the message text
 *   4. Sends via Telegram
 *   5. Records the delivery attempt and final status
 */
import { randomUUID } from "crypto";
import { join } from "path";
import type { Api } from "grammy";
import { cleanEmailBody } from "../cleaner.js";
import {
  renderEmail,
  renderAttachmentFallback,
  renderPrivacyAlert,
  parseModeForRenderMode,
  type AttachmentLink,
} from "../renderer.js";
import { isImageContentType } from "../imageTypes.js";
import type { PhotoItem } from "../../telegram/sender.js";
import { insertDeliveryAttempt } from "../../db/repos/deliveryAttempts.js";
import { updateDeliveryLogStatus } from "../../db/repos/deliveryLogs.js";
import { createAttachment } from "../../db/repos/attachments.js";
import { createAttachmentLink } from "../../db/repos/attachmentLinks.js";
import { writeAttachment, deleteFile } from "../../storage/disk.js";
import { generateDownloadToken } from "../../utils/tokens.js";
import { getLogger } from "../../utils/logger.js";
import { createPrivacyViewUrl } from "../privacy.js";
import { decrementOrganizationStorageUsage } from "../../db/repos/storageUsage.js";
import type { DeliveryLog } from "../../db/schema.js";
import type { parseEmail } from "../parser.js";
import type { Db, QueuedInboundEmail, PipelineResult } from "./types.js";
import { recordDeliveryAttempt, recordTelegramSendFailure } from "../../observability/metrics.js";

interface StoredImageAttachment extends PhotoItem {
  attachmentId: string;
  sizeBytes: number;
}

function getPipelineLogger(correlationId?: string) {
  return correlationId ? getLogger().child({ correlationId }) : getLogger();
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
      let storagePath: string | null = null;
      let attachmentStored = false;
      try {
        const attachmentId = randomUUID();
        const fileId = randomUUID();
        storagePath = join(attachmentDir, deliveryLog.id, `${fileId}.bin`);
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
        attachmentStored = true;

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
        let deletedCompensatingFile = false;
        if (storagePath && !attachmentStored) {
          try {
            await deleteFile(storagePath);
            deletedCompensatingFile = true;
          } catch (deleteErr: unknown) {
            log.error(
              { err: deleteErr, filename: att.filename, deliveryLogId: deliveryLog.id },
              "failed to delete attachment after persistence error",
            );
          }
        }
        if (
          !attachmentStored &&
          deletedCompensatingFile &&
          alias.organizationId &&
          att.sizeBytes != null &&
          att.sizeBytes > 0
        ) {
          await decrementOrganizationStorageUsage(db, alias.organizationId, {
            attachmentBytes: BigInt(att.sizeBytes),
          }).catch((storageErr: unknown) => {
            log.error(
              { err: storageErr, filename: att.filename, deliveryLogId: deliveryLog.id },
              "failed to release reserved attachment storage",
            );
          });
        }
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
      const { sendTelegramMessage, sendTelegramPhotos } = await import("../../telegram/sender.js");
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
      recordDeliveryAttempt(result.ok ? "succeeded" : "failed");

      if (!result.ok) {
        recordTelegramSendFailure(result.error);
        log.error(
          { deliveryLogId: deliveryLog.id, error: result.error },
          "delivery.telegram.failed",
        );
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
              recordTelegramSendFailure(fallbackResult.error);
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
