import type { Api } from "grammy";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../db/schema.js";
import { queueInboundEmail, deliverQueuedEmail } from "./pipeline.js";
import { refundAcceptedEmail } from "../billing/usageRefund.js";
import { notifyApproachingMonthlyLimit } from "../billing/quotaNotifier.js";
import { parseEmail } from "./parser.js";
import { cleanEmailBody } from "./cleaner.js";
import {
  renderEmail,
  renderAttachmentFallback,
  renderPrivacyAlert,
  parseModeForRenderMode,
} from "./renderer.js";
import { isImageContentType, isInlinePhoto } from "./imageTypes.js";
import { sendTelegramMessage, sendTelegramPhotos } from "../telegram/sender.js";
import {
  findLogsNeedingRetry,
  claimDeliveryLogForRetry,
  findDeliveryLogByRawEmailPath,
  updateDeliveryLogStatus,
} from "../db/repos/deliveryLogs.js";
import {
  insertDeliveryAttempt,
  countAttemptsByLog,
  countCountedFailedAttemptsByLog,
} from "../db/repos/deliveryAttempts.js";
import { readAttemptRoute } from "./deliveryRoute.js";
import { repairChatMigration } from "../telegram/chatMigration.js";
import { listAttachmentsByDeliveryLogId } from "../db/repos/attachments.js";
import { createAttachmentLink } from "../db/repos/attachmentLinks.js";
import {
  readRawEmail,
  listPendingRawEmails,
  deletePendingRawEmailMeta,
  deleteFile,
} from "../storage/disk.js";
import { generateDownloadToken } from "../utils/tokens.js";
import { getLogger } from "../utils/logger.js";
import { retryAsync } from "../utils/retryAsync.js";
import { pipelineTracker } from "../utils/inFlight.js";
import { createPrivacyViewUrl } from "./privacy.js";
import { recordRetryAttempt, recordTelegramSendFailure } from "../observability/metrics.js";
import { isBotHealthy } from "../telegram/health.js";
import {
  classifyTelegramError,
  retryDispositionForError,
  UNCOUNTED_RETRY_ERROR_CLASSES,
} from "../telegram/errorClassifier.js";

type Db = NodePgDatabase<typeof schema>;

// Budget of *counted* failed attempts (chat/message-level errors) before a
// delivery is closed as permanently_failed. Global-transient failures
// (Telegram down, network, flood-wait) do not consume this budget — those
// deliveries stay retryable until their raw email TTL expires.
const MAX_RETRIES = 3;
const STALE_DELIVERY_MS = 2 * 60 * 1000;
// A "processing" log is only retried once its processing_started_at is older
// than this — well beyond any realistic delivery time (Telegram sends plus
// flood-wait) — so the retry worker never races a live in-progress delivery.
const PROCESSING_STALE_MS = 10 * 60 * 1000;

// The Telegram send is irreversible; retry the persistence of its outcome a few
// times so a transient DB blip cannot strand the record and cause a resend.
const POST_SEND_PERSIST_RETRY = { attempts: 3, delaysMs: [200, 1000] } as const;

function shouldDeletePendingRawEmail(reason: string | undefined): boolean {
  return (
    reason === "duplicate" ||
    reason === "alias_not_found" ||
    reason === "sender_not_allowed" ||
    reason === "sender_auth_failed" ||
    reason === "subscription_inactive" ||
    reason === "monthly_email_limit" ||
    reason === "message_size_limit" ||
    reason === "storage_limit"
  );
}

export async function runRetryWorker(
  db: Db,
  api: Api | null,
  {
    attachmentTtlHours = 24,
    rawEmailTtlHours = 24,
    publicBaseUrl = "",
    attachmentDir = "",
    rawEmailDir,
  }: {
    attachmentTtlHours?: number;
    rawEmailTtlHours?: number;
    publicBaseUrl?: string;
    attachmentDir?: string;
    rawEmailDir?: string;
  } = {},
): Promise<void> {
  if (!api) return;

  const log = getLogger();

  // The polling restart loop probes Telegram every few seconds while it is
  // down; sending now would only burn the 30s API timeout per log. Nothing is
  // lost by waiting: transient failures do not consume retry budget and the
  // logs stay retryable until their raw email TTL expires.
  if (!isBotHealthy()) {
    log.info("retry worker: skipping cycle while the Telegram API is unreachable");
    return;
  }

  if (rawEmailDir) {
    await recoverPendingRawEmails(db, api, {
      attachmentDir,
      attachmentTtlHours,
      rawEmailTtlHours,
      publicBaseUrl,
      rawEmailDir,
    });
  }

  const now = Date.now();
  const retryableLogs = await findLogsNeedingRetry(
    db,
    new Date(now - STALE_DELIVERY_MS),
    new Date(now - PROCESSING_STALE_MS),
  );

  if (retryableLogs.length === 0) return;

  log.info({ count: retryableLogs.length }, "retry worker: processing retryable deliveries");

  for (const deliveryLog of retryableLogs) {
    if (pipelineTracker.isActive(deliveryLog.id)) continue;

    const claimed = await claimDeliveryLogForRetry(db, deliveryLog.id);
    if (!claimed) continue;

    try {
      await pipelineTracker.runFor(deliveryLog.id, () =>
        retryDelivery(db, api, deliveryLog, {
          attachmentTtlHours,
          rawEmailTtlHours,
          publicBaseUrl,
        }),
      );
    } catch (err: unknown) {
      log.error({ err, deliveryLogId: deliveryLog.id }, "retry worker: unexpected error");
      await updateDeliveryLogStatus(db, deliveryLog.id, "failed").catch((statusErr: unknown) => {
        log.error(
          { err: statusErr, deliveryLogId: deliveryLog.id },
          "retry worker: failed to reset delivery status after error",
        );
      });
    }
  }
}

async function recoverPendingRawEmails(
  db: Db,
  api: Api,
  opts: {
    attachmentTtlHours: number;
    rawEmailTtlHours: number;
    publicBaseUrl: string;
    attachmentDir: string;
    rawEmailDir: string;
  },
): Promise<void> {
  const log = getLogger();
  const pendingRawEmails = await listPendingRawEmails(opts.rawEmailDir);

  for (const pendingEmail of pendingRawEmails) {
    try {
      const existingLog = await findDeliveryLogByRawEmailPath(db, pendingEmail.rawEmailPath);
      if (existingLog) {
        await deletePendingRawEmailMeta(pendingEmail.rawEmailPath);
        continue;
      }

      let rawEmail: Buffer;
      try {
        rawEmail = await readRawEmail(pendingEmail.rawEmailPath, {
          rawEmailEncryptionMode: pendingEmail.rawEmailEncryptionMode ?? null,
          rawEmailWrappedDek: pendingEmail.rawEmailWrappedDek ?? null,
          rawEmailKekKeyId: pendingEmail.rawEmailKekKeyId ?? null,
        });
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          await deletePendingRawEmailMeta(pendingEmail.rawEmailPath);
          continue;
        }
        throw err;
      }

      const queued = await queueInboundEmail(db, {
        rawEmail,
        rawEmailPath: pendingEmail.rawEmailPath,
        localPart: pendingEmail.localPart,
        recipientDomain: pendingEmail.recipientDomain ?? undefined,
        envelopeFrom: pendingEmail.envelopeFrom ?? undefined,
        correlationId: pendingEmail.correlationId,
        rawEmailEncryption: {
          encryptionMode: pendingEmail.rawEmailEncryptionMode === "local-v1" ? "local-v1" : "none",
          wrappedDek: pendingEmail.rawEmailWrappedDek ?? null,
          kekKeyId: pendingEmail.rawEmailKekKeyId ?? null,
          encryptedAt: null,
        },
        publicBaseUrl: opts.publicBaseUrl,
        attachmentDir: opts.attachmentDir,
        attachmentTtlHours: opts.attachmentTtlHours,
        rawEmailTtlHours: opts.rawEmailTtlHours,
      });

      if (!queued.queued) {
        if (shouldDeletePendingRawEmail(queued.result.reason)) {
          await deletePendingRawEmailMeta(pendingEmail.rawEmailPath);
          await deleteFile(pendingEmail.rawEmailPath).catch((err: unknown) => {
            log.warn(
              { err, rawEmailPath: pendingEmail.rawEmailPath },
              "retry worker: failed to delete rejected raw email",
            );
          });
        } else {
          log.warn(
            { rawEmailPath: pendingEmail.rawEmailPath, reason: queued.result.reason },
            "retry worker: keeping pending raw email for a later retry",
          );
        }
        continue;
      }

      await deletePendingRawEmailMeta(pendingEmail.rawEmailPath);

      // Recovery charges usage exactly like live ingress, so it must also be
      // able to trigger the approaching-limit warning — a recovered batch can
      // carry a user through the 80–99% band that live traffic never sees.
      const ownerId = queued.job.deliveryLog.userId;
      if (ownerId != null && queued.usage) {
        void notifyApproachingMonthlyLimit(
          db,
          api,
          ownerId,
          queued.usage.month,
          queued.usage.deliveredCount,
        );
      }

      await pipelineTracker.runFor(queued.job.deliveryLog.id, () =>
        deliverQueuedEmail(db, api, queued.job),
      );
    } catch (err: unknown) {
      log.error(
        { err, rawEmailPath: pendingEmail.rawEmailPath },
        "retry worker: failed to recover pending raw email",
      );
    }
  }
}

async function retryDelivery(
  db: Db,
  api: Api,
  deliveryLog: {
    id: string;
    emailAddressId: string;
    userId: bigint | null;
    rawEmailPath: string | null;
    receivedAt: Date;
    rawEmailEncryptionMode: string | null;
    rawEmailWrappedDek: string | null;
    rawEmailKekKeyId: string | null;
  },
  opts: { attachmentTtlHours: number; rawEmailTtlHours: number; publicBaseUrl: string },
): Promise<void> {
  const log = getLogger();

  // Marks the log permanently failed and refunds the monthly-quota charge the
  // acceptance path took: the user never received this email, so it must not
  // count against their plan.
  const closePermanentlyFailed = async (): Promise<void> => {
    recordRetryAttempt("permanently_failed");
    await updateDeliveryLogStatus(db, deliveryLog.id, "permanently_failed");
    await refundAcceptedEmail(db, {
      deliveryLogId: deliveryLog.id,
      userId: deliveryLog.userId,
      receivedAt: deliveryLog.receivedAt,
    });
  };

  if (!deliveryLog.rawEmailPath) {
    await closePermanentlyFailed();
    return;
  }

  const attempts = await countAttemptsByLog(db, deliveryLog.id);
  const countedFailures = await countCountedFailedAttemptsByLog(
    db,
    deliveryLog.id,
    UNCOUNTED_RETRY_ERROR_CLASSES,
  );
  if (countedFailures >= MAX_RETRIES) {
    log.warn(
      { deliveryLogId: deliveryLog.id, attempts, countedFailures },
      "retry worker: max retries reached",
    );
    await closePermanentlyFailed();
    return;
  }

  // The attempt's ONE fresh alias read: it both revalidates the alias
  // (may have been paused/deleted since original delivery) and freezes the
  // route every send of this attempt must use — text, photos, fallback,
  // and the attempt record. A move/migration lands on the next attempt.
  const attemptRoute = await readAttemptRoute(db, deliveryLog.emailAddressId);
  if (!attemptRoute.ok) {
    log.warn(
      { deliveryLogId: deliveryLog.id, aliasStatus: attemptRoute.aliasStatus ?? undefined },
      "retry worker: alias unavailable, giving up",
    );
    await closePermanentlyFailed();
    return;
  }
  const { alias, route } = attemptRoute;

  // Re-read and re-parse raw email
  let rawEmail: Buffer;
  try {
    rawEmail = await readRawEmail(deliveryLog.rawEmailPath, {
      rawEmailEncryptionMode: deliveryLog.rawEmailEncryptionMode,
      rawEmailWrappedDek: deliveryLog.rawEmailWrappedDek,
      rawEmailKekKeyId: deliveryLog.rawEmailKekKeyId,
    });
  } catch (err: unknown) {
    log.error({ err, deliveryLogId: deliveryLog.id }, "retry worker: raw email file missing");
    await closePermanentlyFailed();
    return;
  }

  const parsed = await parseEmail(rawEmail, rawEmail.length);
  if (parsed.textBody) {
    parsed.textBody = cleanEmailBody(parsed.textBody);
  }

  const privacyMode = alias.privacyModeEnabled ?? false;
  const storedAttachments = await listAttachmentsByDeliveryLogId(db, deliveryLog.id);
  const attachmentLinks = privacyMode
    ? []
    : await Promise.all(
        storedAttachments
          .filter(
            (attachment) => !isInlinePhoto(attachment.contentType ?? "", attachment.sizeBytes),
          )
          .map(async (attachment) => {
            const { token, expiresAt } = generateDownloadToken(
              attachment.id,
              opts.attachmentTtlHours,
            );
            await createAttachmentLink(db, attachment.id, token, expiresAt);
            return {
              filename: attachment.originalFilename ?? "attachment",
              sizeBytes: attachment.sizeBytes ?? 0,
              url: `${opts.publicBaseUrl}/dl/${token}`,
            };
          }),
      );
  const imageAttachments = storedAttachments
    .filter((attachment) => isInlinePhoto(attachment.contentType ?? "", attachment.sizeBytes))
    .map((attachment) => ({
      id: attachment.id,
      storagePath: attachment.storagePath,
      filename: attachment.originalFilename ?? "attachment",
      encryptionMode: attachment.encryptionMode,
      wrappedDek: attachment.wrappedDek,
      kekKeyId: attachment.kekKeyId,
    }));

  const renderMode = (alias.renderMode ?? "plaintext") as "plaintext" | "html" | "markdown";
  const text = privacyMode
    ? await buildPrivacyRetryMessage(db, deliveryLog, parsed, alias.fullAddress, opts)
    : renderEmail(parsed, renderMode, alias.fullAddress, attachmentLinks);
  const parseMode = privacyMode ? "HTML" : parseModeForRenderMode(renderMode);

  const result = await sendTelegramMessage(api, {
    chatId: route.chatId,
    threadId: route.threadId,
    text,
    parseMode,
  });

  const newAttemptNo = attempts + 1;
  const sendErrorClass = result.ok ? null : classifyTelegramError(result.failure ?? result.error);
  const disposition = result.ok ? null : retryDispositionForError(result.failure ?? result.error);
  const countedAfterSend = disposition === "retry_counted" ? countedFailures + 1 : countedFailures;
  const finalStatus = result.ok
    ? "delivered"
    : disposition === "fail_permanently" || countedAfterSend >= MAX_RETRIES
      ? "permanently_failed"
      : "failed";

  // Persist the attempt row and the final status atomically, with bounded
  // retries: the send already happened, so a failed write here would leave the
  // log retryable and cause a duplicate send on the next worker cycle.
  await retryAsync(
    () =>
      db.transaction(async (tx) => {
        const workDb = tx as Db;
        await insertDeliveryAttempt(workDb, {
          deliveryLogId: deliveryLog.id,
          attemptNo: newAttemptNo,
          targetChatId: route.chatId,
          targetThreadId: route.threadId,
          telegramMessageId: result.telegramMessageId ? BigInt(result.telegramMessageId) : null,
          status: result.ok ? "succeeded" : "failed",
          errorText: result.error ?? null,
          errorClass: sendErrorClass,
        });
        await updateDeliveryLogStatus(workDb, deliveryLog.id, finalStatus);
      }),
    POST_SEND_PERSIST_RETRY,
  );

  if (finalStatus === "permanently_failed") {
    await refundAcceptedEmail(db, {
      deliveryLogId: deliveryLog.id,
      userId: deliveryLog.userId,
      receivedAt: deliveryLog.receivedAt,
    });
  }

  // The chat migrated: repair the routing so the NEXT worker cycle reads the
  // new id (a `migrated` failure is uncounted, so the log stayed retryable).
  // Repair failure must never escalate the delivery's status.
  if (result.failure?.migrateToChatId != null) {
    await repairChatMigration(db, api, route.chatId, result.failure.migrateToChatId).catch(
      (repairErr: unknown) => {
        log.error(
          { err: repairErr, deliveryLogId: deliveryLog.id },
          "retry worker: chat.migration_repair_failed",
        );
      },
    );
  }

  if (result.ok) {
    recordRetryAttempt("succeeded");
    log.info({ deliveryLogId: deliveryLog.id, attemptNo: newAttemptNo }, "retry worker: delivered");

    /**
     * Chat upgraded mid-attempt, after the text landed. Repair, then hand the
     * delivery back as retryable so the next cycle re-reads the route and
     * delivers the WHOLE email to the new chat. Costs a visible duplicate;
     * the alternative silently drops the attachments (user decision
     * 2026-07-20). The attempt row stays `succeeded`, so no retry budget is
     * consumed and no refund is triggered.
     */
    const abortAttemptForMigration = async (newChatId: bigint): Promise<void> => {
      await repairChatMigration(db, api, route.chatId, newChatId).catch((repairErr: unknown) => {
        log.error(
          { err: repairErr, deliveryLogId: deliveryLog.id },
          "retry worker: chat.migration_repair_failed",
        );
      });
      await updateDeliveryLogStatus(db, deliveryLog.id, "failed").catch((statusErr: unknown) => {
        log.error(
          { err: statusErr, deliveryLogId: deliveryLog.id },
          "retry worker: migration_retry_reset_failed",
        );
      });
      log.warn(
        { deliveryLogId: deliveryLog.id, oldChatId: route.chatId.toString() },
        "retry worker: delivery.aborted_for_migration",
      );
    };

    if (!privacyMode && imageAttachments.length > 0) {
      try {
        const photoResult = await sendTelegramPhotos(api, {
          chatId: route.chatId,
          threadId: route.threadId,
          replyToMessageId: result.telegramMessageId,
          photos: imageAttachments,
        });

        const photoMigrateTo = photoResult.failure?.migrateToChatId ?? null;
        if (photoMigrateTo != null) {
          await abortAttemptForMigration(photoMigrateTo);
          return;
        } else if (photoResult.failedPhotos.length > 0) {
          const failedPaths = new Set(photoResult.failedPhotos.map((photo) => photo.storagePath));
          const fallbackLinks = await Promise.all(
            storedAttachments
              .filter(
                (attachment) =>
                  isImageContentType(attachment.contentType ?? "") &&
                  failedPaths.has(attachment.storagePath),
              )
              .map(async (attachment) => {
                const { token, expiresAt } = generateDownloadToken(
                  attachment.id,
                  opts.attachmentTtlHours,
                );
                await createAttachmentLink(db, attachment.id, token, expiresAt);
                return {
                  filename: attachment.originalFilename ?? "attachment",
                  sizeBytes: attachment.sizeBytes ?? 0,
                  url: `${opts.publicBaseUrl}/dl/${token}`,
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
              "retry worker: image attachment fallback delivery failed",
            );
            if (fallbackResult.failure?.migrateToChatId != null) {
              await abortAttemptForMigration(fallbackResult.failure.migrateToChatId);
              return;
            }
          }
        }
      } catch (err: unknown) {
        log.error(
          { err, deliveryLogId: deliveryLog.id },
          "retry worker: image attachment secondary delivery failed",
        );
      }
    }
  } else if (finalStatus === "permanently_failed") {
    recordRetryAttempt("permanently_failed");
    recordTelegramSendFailure(result.error);
    log.warn(
      { deliveryLogId: deliveryLog.id, error: result.error, errorClass: sendErrorClass },
      "retry worker: permanently failed",
    );
  } else {
    recordRetryAttempt("failed");
    recordTelegramSendFailure(result.error);
    log.warn(
      {
        deliveryLogId: deliveryLog.id,
        attemptNo: newAttemptNo,
        error: result.error,
        errorClass: sendErrorClass,
      },
      "retry worker: will retry again",
    );
  }
}

async function buildPrivacyRetryMessage(
  db: Db,
  deliveryLog: { id: string; rawEmailPath: string | null; receivedAt: Date },
  parsed: Awaited<ReturnType<typeof parseEmail>>,
  aliasFullAddress: string,
  opts: { publicBaseUrl: string; rawEmailTtlHours: number },
): Promise<string> {
  if (!deliveryLog.rawEmailPath) {
    throw new Error("privacy mode requires a durable raw email path");
  }

  const viewUrl = await createPrivacyViewUrl(
    db,
    deliveryLog.id,
    opts.publicBaseUrl,
    new Date(deliveryLog.receivedAt.getTime() + opts.rawEmailTtlHours * 60 * 60 * 1000),
  );

  return renderPrivacyAlert(parsed, aliasFullAddress, viewUrl, parsed.attachments.length > 0);
}
