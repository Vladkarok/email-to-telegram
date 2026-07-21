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
import { sql } from "drizzle-orm";
import { cleanEmailBody } from "../cleaner.js";
import {
  renderEmail,
  renderAttachmentFallback,
  renderPrivacyAlert,
  parseModeForRenderMode,
  type AttachmentLink,
} from "../renderer.js";
import { isInlinePhoto } from "../imageTypes.js";
import type { PhotoItem } from "../../telegram/sender.js";
import { findAliasById } from "../../db/repos/aliases.js";
import { insertDeliveryAttempt } from "../../db/repos/deliveryAttempts.js";
import { updateDeliveryLogStatus, markDeliveryLogProcessing } from "../../db/repos/deliveryLogs.js";
import { createAttachment } from "../../db/repos/attachments.js";
import { createAttachmentLink } from "../../db/repos/attachmentLinks.js";
import { writeAttachment, deleteFile } from "../../storage/disk.js";
import { generateDownloadToken } from "../../utils/tokens.js";
import { getLogger } from "../../utils/logger.js";
import { retryAsync } from "../../utils/retryAsync.js";
import { createPrivacyViewUrl } from "../privacy.js";
import { decrementUserStorageUsage } from "../../db/repos/storageUsage.js";
import type { DeliveryLog } from "../../db/schema.js";
import type { parseEmail } from "../parser.js";
import type { Db, QueuedInboundEmail, PipelineResult } from "./types.js";
import { recordDeliveryAttempt, recordTelegramSendFailure } from "../../observability/metrics.js";
import { classifyTelegramError, retryDispositionForError } from "../../telegram/errorClassifier.js";
import { readAttemptRoute } from "../deliveryRoute.js";
import { repairChatMigration } from "../../telegram/chatMigration.js";
import { refundAcceptedEmail } from "../../billing/usageRefund.js";

interface StoredImageAttachment extends PhotoItem {
  attachmentId: string;
  sizeBytes: number;
}

// The Telegram send is irreversible; if persisting its outcome fails the retry
// worker would resend (a duplicate). Retry the persistence a few times before
// giving up so a transient DB blip cannot strand the record.
const POST_SEND_PERSIST_RETRY = { attempts: 3, delaysMs: [200, 1000] } as const;

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
    const prepared = await db.transaction(async (tx) => {
      const workDb = tx as Db;
      await tx.execute(sql`select pg_advisory_xact_lock(${alias.createdBy})`);

      const currentAlias = await findAliasById(workDb, alias.id);
      if (
        !currentAlias ||
        currentAlias.status !== "active" ||
        currentAlias.createdBy !== alias.createdBy
      ) {
        log.info(
          {
            deliveryLogId: deliveryLog.id,
            aliasId: alias.id,
            userId: alias.createdBy.toString(),
          },
          "delivery.aborted_after_user_deletion",
        );
        return { ok: false as const };
      }

      await markDeliveryLogProcessing(workDb, deliveryLog.id);

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

          const dbAtt = await createAttachment(workDb, {
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

          if (isInlinePhoto(att.contentType, att.sizeBytes)) {
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
            await createAttachmentLink(workDb, dbAtt.id, token, expiresAt);
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
            att.sizeBytes != null &&
            att.sizeBytes > 0
          ) {
            await decrementUserStorageUsage(workDb, alias.createdBy, {
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
        ? await buildPrivacyModeMessage(
            workDb,
            deliveryLog,
            parsed,
            alias.fullAddress,
            publicBaseUrl,
            {
              rawEmailTtlHours,
            },
          )
        : renderEmail(parsed, renderMode, alias.fullAddress, attachmentLinks);

      return {
        ok: true as const,
        imageAttachments,
        parseMode: privacyMode ? "HTML" : parseModeForRenderMode(renderMode),
        text,
      };
    });

    if (!prepared.ok) {
      return { ok: false, reason: "user_deleted" };
    }

    // 9. Send — parse_mode depends on render mode; plaintext uses none (avoids HTML metachar issues)
    if (api) {
      const { sendTelegramMessage, sendTelegramPhotos } = await import("../../telegram/sender.js");

      const stillActive = await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(${alias.createdBy})`);

        const currentAlias = await findAliasById(tx as Db, alias.id);
        if (
          !currentAlias ||
          currentAlias.status !== "active" ||
          currentAlias.createdBy !== alias.createdBy
        ) {
          log.info(
            {
              deliveryLogId: deliveryLog.id,
              aliasId: alias.id,
              userId: alias.createdBy.toString(),
            },
            "delivery.aborted_after_user_deletion",
          );
          return false;
        }

        return true;
      });

      if (!stillActive) {
        return { ok: false, reason: "user_deleted" };
      }

      // Final non-transactional recheck right before the irreversible Telegram
      // send. Narrows the /delete_me race window from "Telegram API latency" to
      // "one DB roundtrip". Cannot fully close it without holding a tx across
      // the network call. This is also the attempt's ONE route read: every
      // send below (text, photos, fallback) and the attempt record must use
      // `route`, never the queued alias's chat/thread.
      const attemptRoute = await readAttemptRoute(db, alias.id);
      if (!attemptRoute.ok || attemptRoute.alias.createdBy !== alias.createdBy) {
        log.info(
          {
            deliveryLogId: deliveryLog.id,
            aliasId: alias.id,
            userId: alias.createdBy.toString(),
          },
          "delivery.aborted_after_user_deletion",
        );
        return { ok: false, reason: "user_deleted" };
      }
      const { route } = attemptRoute;

      const result = await sendTelegramMessage(api, {
        chatId: route.chatId,
        threadId: route.threadId,
        text: prepared.text,
        parseMode: prepared.parseMode,
      });

      // A chat-level permanent error (bot blocked, chat deleted) can never
      // succeed on retry; close the log immediately instead of burning retry
      // cycles against an unreachable chat.
      const sendErrorClass = result.ok
        ? null
        : classifyTelegramError(result.failure ?? result.error);
      const failedStatus =
        !result.ok &&
        retryDispositionForError(result.failure ?? result.error) === "fail_permanently"
          ? "permanently_failed"
          : "failed";

      try {
        await retryAsync(
          () =>
            db.transaction(async (tx) => {
              const workDb = tx as Db;
              await insertDeliveryAttempt(workDb, {
                deliveryLogId: deliveryLog.id,
                attemptNo: 1,
                targetChatId: route.chatId,
                targetThreadId: route.threadId,
                telegramMessageId: result.telegramMessageId
                  ? BigInt(result.telegramMessageId)
                  : null,
                status: result.ok ? "succeeded" : "failed",
                errorText: result.error ?? null,
                errorClass: sendErrorClass,
              });

              const finalStatus = result.ok ? "delivered" : failedStatus;
              await updateDeliveryLogStatus(workDb, deliveryLog.id, finalStatus);
            }),
          POST_SEND_PERSIST_RETRY,
        );
      } catch (logErr: unknown) {
        // The Telegram send already happened. If we can't persist the outcome,
        // the retry worker will redeliver and the user sees a duplicate. Log
        // loudly so this is alertable.
        log.error(
          {
            err: logErr,
            deliveryLogId: deliveryLog.id,
            telegramSent: result.ok,
            telegramMessageId: result.telegramMessageId ?? null,
          },
          "delivery.attempt_log_persist_failed",
        );
        throw logErr;
      }
      recordDeliveryAttempt(result.ok ? "succeeded" : "failed");

      if (!result.ok) {
        recordTelegramSendFailure(result.error);
        log.error(
          { deliveryLogId: deliveryLog.id, error: result.error, errorClass: sendErrorClass },
          failedStatus === "permanently_failed"
            ? "delivery.telegram.permanently_failed"
            : "delivery.telegram.failed",
        );
        if (failedStatus === "permanently_failed") {
          // The user never received this email; give the monthly-quota
          // charge from acceptance back.
          await refundAcceptedEmail(db, {
            deliveryLogId: deliveryLog.id,
            userId: deliveryLog.userId,
            receivedAt: deliveryLog.receivedAt,
          });
        }
        // The chat migrated mid-attempt: repair the alias routing so the
        // retry (status stayed "failed", uncounted) lands on the new id.
        // Repair failure keeps the delivery retryable — never rethrow.
        if (result.failure?.migrateToChatId != null) {
          await repairChatMigration(db, api, route.chatId, result.failure.migrateToChatId).catch(
            (repairErr: unknown) => {
              log.error(
                { err: repairErr, deliveryLogId: deliveryLog.id },
                "chat.migration_repair_failed",
              );
            },
          );
        }
        return { ok: false, reason: "send_failed" };
      }

      /**
       * The chat upgraded mid-attempt, after the text had already landed.
       * Repair the routing and hand the delivery back to the retry worker so
       * the NEXT attempt re-reads the route and delivers the whole email to
       * the new chat.
       *
       * This deliberately costs a duplicate: the text the user already
       * received is re-sent to the migrated chat (history survives an
       * upgrade, so it lands in the same visible conversation). The
       * alternative — keeping this attempt `delivered` — silently drops the
       * attachments, and a duplicate the user can see and ignore beats an
       * attachment they never learn existed. User decision, 2026-07-20.
       */
      const abortAttemptForMigration = async (newChatId: bigint): Promise<PipelineResult> => {
        await repairChatMigration(db, api, route.chatId, newChatId).catch((repairErr: unknown) => {
          log.error(
            { err: repairErr, deliveryLogId: deliveryLog.id },
            "chat.migration_repair_failed",
          );
        });
        // Back to retryable. The attempt row stays `succeeded`, so this does
        // not consume the bounded retry budget and cannot trigger a refund.
        await updateDeliveryLogStatus(db, deliveryLog.id, "failed").catch((statusErr: unknown) => {
          log.error(
            { err: statusErr, deliveryLogId: deliveryLog.id },
            "delivery.migration_retry_reset_failed",
          );
        });
        log.warn(
          { deliveryLogId: deliveryLog.id, oldChatId: route.chatId.toString() },
          "delivery.aborted_for_migration",
        );
        return { ok: false, reason: "chat_migrated" };
      };

      // Send image attachments as Telegram photos (replied to the text message)
      if (!privacyMode && prepared.imageAttachments.length > 0) {
        try {
          const photoResult = await sendTelegramPhotos(api, {
            chatId: route.chatId,
            threadId: route.threadId,
            replyToMessageId: result.telegramMessageId,
            photos: prepared.imageAttachments.map(
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

          const photoMigrateTo = photoResult.failure?.migrateToChatId ?? null;
          if (photoMigrateTo != null) {
            return await abortAttemptForMigration(photoMigrateTo);
          } else if (photoResult.failedPhotos.length > 0) {
            const failedPaths = new Set(photoResult.failedPhotos.map((photo) => photo.storagePath));
            const fallbackLinks = await Promise.all(
              prepared.imageAttachments
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
              chatId: route.chatId,
              threadId: route.threadId,
              text: renderAttachmentFallback(fallbackLinks),
            });

            if (!fallbackResult.ok) {
              recordTelegramSendFailure(fallbackResult.error);
              log.error(
                { deliveryLogId: deliveryLog.id, error: fallbackResult.error },
                "image attachment fallback delivery failed",
              );
              // The upgrade can just as easily land on this last send.
              if (fallbackResult.failure?.migrateToChatId != null) {
                return await abortAttemptForMigration(fallbackResult.failure.migrateToChatId);
              }
            }
          }
        } catch (err: unknown) {
          log.error(
            { err, deliveryLogId: deliveryLog.id },
            "image attachment secondary delivery failed",
          );
        }
      }

      return { ok: true };
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
