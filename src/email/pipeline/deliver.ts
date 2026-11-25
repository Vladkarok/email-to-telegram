/**
 * Inbound email delivery stage.
 *
 * Receives a pre-validated, pre-logged QueuedInboundEmail job and:
 *   1. Cleans the body
 *   2. Persists attachments (images → Telegram photos, others → download links)
 *   3. Renders the message text
 *   4. Runs the delivery attempt (../deliveryAttempt.ts): sends via Telegram,
 *      records the attempt and final status, sends the attachments
 */
import { randomUUID } from "crypto";
import { join } from "path";
import type { Api } from "grammy";
import { sql } from "drizzle-orm";
import { cleanEmailBody } from "../cleaner.js";
import type { AttachmentLink } from "../renderer.js";
import { isInlinePhoto } from "../imageTypes.js";
import type { PhotoItem } from "../../telegram/sender.js";
import { findAliasById } from "../../db/repos/aliases.js";
import {
  markDeliveryLogProcessing,
  resetDeliveryLogAfterError,
} from "../../db/repos/deliveryLogs.js";
import { createAttachment } from "../../db/repos/attachments.js";
import { createAttachmentLink } from "../../db/repos/attachmentLinks.js";
import { writeAttachment, deleteFile } from "../../storage/disk.js";
import { generateDownloadToken } from "../../utils/tokens.js";
import { getLogger } from "../../utils/logger.js";
import { decrementUserStorageUsage } from "../../db/repos/storageUsage.js";
import type { Db, QueuedInboundEmail, PipelineResult } from "./types.js";
import { recordDeliveryAttempt, recordTelegramSendFailure } from "../../observability/metrics.js";
import { readAttemptRoute } from "../deliveryRoute.js";
import {
  renderAttemptMessage,
  runDeliveryAttempt,
  sendFailureLogFields,
} from "../deliveryAttempt.js";

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

          const newAttachment = {
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
          };
          // Each insert runs in its own savepoint: a failed statement would
          // otherwise abort the whole transaction, and the catch below could
          // neither compensate nor let the remaining attachments through.
          const dbAtt = await tx.transaction((savepoint) =>
            createAttachment(savepoint as Db, newAttachment),
          );
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
            await tx.transaction((savepoint) =>
              createAttachmentLink(savepoint as Db, dbAtt.id, token, expiresAt),
            );
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
      const rendered = await renderAttemptMessage(workDb, {
        privacyMode,
        renderMode: alias.renderMode,
        aliasFullAddress: alias.fullAddress,
        parsed,
        attachmentLinks,
        deliveryLog,
        publicBaseUrl,
        rawEmailTtlHours,
      });

      return {
        ok: true as const,
        imageAttachments,
        parseMode: rendered.parseMode,
        richHtml: rendered.richHtml,
        richIneligibleReason: rendered.richIneligibleReason,
        text: rendered.text,
      };
    });

    if (!prepared.ok) {
      return { ok: false, reason: "user_deleted" };
    }

    // 9. Send — parse_mode depends on render mode; plaintext uses none (avoids HTML metachar issues)
    if (api) {
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

      const outcome = await runDeliveryAttempt(db, api, {
        path: "initial",
        log,
        deliveryLog,
        aliasId: alias.id,
        route,
        attemptNo: 1,
        message: {
          text: prepared.text,
          parseMode: prepared.parseMode,
          richHtml: prepared.richHtml,
          richIneligibleReason: prepared.richIneligibleReason,
          richMessagesEnabled: job.telegramRichMessagesEnabled,
        },
        privacyMode,
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
        fallbackAttachments: prepared.imageAttachments.map(
          ({ attachmentId, storagePath, filename, sizeBytes }) => ({
            attachmentId,
            storagePath,
            filename,
            sizeBytes,
          }),
        ),
        publicBaseUrl,
        attachmentTtlHours,
        // A chat-level permanent error (bot blocked, chat deleted) can never
        // succeed on retry; close the log immediately instead of burning retry
        // cycles against an unreachable chat.
        failedStatus: (disposition) =>
          disposition === "fail_permanently" ? "permanently_failed" : "failed",
        afterCommit: (attempt) => {
          recordDeliveryAttempt(attempt.result.ok ? "succeeded" : "failed");
          if (attempt.result.ok) return;
          recordTelegramSendFailure(attempt.result.error);
          log.error(
            { deliveryLogId: deliveryLog.id, ...sendFailureLogFields(attempt) },
            attempt.status === "permanently_failed"
              ? "delivery.telegram.permanently_failed"
              : "delivery.telegram.failed",
          );
        },
      });
      return outcome === "delivered" ? { ok: true } : { ok: false, reason: outcome };
    }

    return { ok: true };
  } catch (err: unknown) {
    await resetDeliveryLogAfterError(db, deliveryLog.id).catch((statusErr: unknown) => {
      log.error(
        { err: statusErr, deliveryLogId: deliveryLog.id },
        "failed to mark delivery failed",
      );
    });
    throw err;
  }
}
