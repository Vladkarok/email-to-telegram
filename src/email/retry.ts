import type { Api } from "grammy";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../db/schema.js";
import { queueInboundEmail, deliverQueuedEmail } from "./pipeline.js";
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
import { insertDeliveryAttempt, countAttemptsByLog } from "../db/repos/deliveryAttempts.js";
import { findAliasById } from "../db/repos/aliases.js";
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

type Db = NodePgDatabase<typeof schema>;

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
    rawEmailPath: string | null;
    receivedAt: Date;
    rawEmailEncryptionMode: string | null;
    rawEmailWrappedDek: string | null;
    rawEmailKekKeyId: string | null;
  },
  opts: { attachmentTtlHours: number; rawEmailTtlHours: number; publicBaseUrl: string },
): Promise<void> {
  const log = getLogger();

  if (!deliveryLog.rawEmailPath) {
    recordRetryAttempt("permanently_failed");
    await updateDeliveryLogStatus(db, deliveryLog.id, "permanently_failed");
    return;
  }

  const attempts = await countAttemptsByLog(db, deliveryLog.id);
  if (attempts >= MAX_RETRIES) {
    log.warn({ deliveryLogId: deliveryLog.id, attempts }, "retry worker: max retries reached");
    recordRetryAttempt("permanently_failed");
    await updateDeliveryLogStatus(db, deliveryLog.id, "permanently_failed");
    return;
  }

  // Look up alias — may have been paused/deleted since original delivery
  const alias = await findAliasById(db, deliveryLog.emailAddressId);
  if (!alias || alias.status !== "active") {
    log.warn(
      { deliveryLogId: deliveryLog.id, aliasStatus: alias?.status },
      "retry worker: alias unavailable, giving up",
    );
    recordRetryAttempt("permanently_failed");
    await updateDeliveryLogStatus(db, deliveryLog.id, "permanently_failed");
    return;
  }

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
    recordRetryAttempt("permanently_failed");
    await updateDeliveryLogStatus(db, deliveryLog.id, "permanently_failed");
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
    chatId: alias.chatId,
    threadId: alias.messageThreadId ?? null,
    text,
    parseMode,
  });

  const newAttemptNo = attempts + 1;
  const finalStatus = result.ok
    ? "delivered"
    : newAttemptNo >= MAX_RETRIES
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
          targetChatId: alias.chatId,
          targetThreadId: alias.messageThreadId ?? null,
          telegramMessageId: result.telegramMessageId ? BigInt(result.telegramMessageId) : null,
          status: result.ok ? "succeeded" : "failed",
          errorText: result.error ?? null,
        });
        await updateDeliveryLogStatus(workDb, deliveryLog.id, finalStatus);
      }),
    POST_SEND_PERSIST_RETRY,
  );

  if (result.ok) {
    recordRetryAttempt("succeeded");
    log.info({ deliveryLogId: deliveryLog.id, attemptNo: newAttemptNo }, "retry worker: delivered");

    if (!privacyMode && imageAttachments.length > 0) {
      try {
        const photoResult = await sendTelegramPhotos(api, {
          chatId: alias.chatId,
          threadId: alias.messageThreadId ?? null,
          replyToMessageId: result.telegramMessageId,
          photos: imageAttachments,
        });

        if (photoResult.failedPhotos.length > 0) {
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
            chatId: alias.chatId,
            threadId: alias.messageThreadId ?? null,
            text: renderAttachmentFallback(fallbackLinks),
          });

          if (!fallbackResult.ok) {
            recordTelegramSendFailure(fallbackResult.error);
            log.error(
              { deliveryLogId: deliveryLog.id, error: fallbackResult.error },
              "retry worker: image attachment fallback delivery failed",
            );
          }
        }
      } catch (err: unknown) {
        log.error(
          { err, deliveryLogId: deliveryLog.id },
          "retry worker: image attachment secondary delivery failed",
        );
      }
    }
  } else if (newAttemptNo >= MAX_RETRIES) {
    recordRetryAttempt("permanently_failed");
    recordTelegramSendFailure(result.error);
    log.warn(
      { deliveryLogId: deliveryLog.id, error: result.error },
      "retry worker: permanently failed",
    );
  } else {
    recordRetryAttempt("failed");
    recordTelegramSendFailure(result.error);
    log.warn(
      { deliveryLogId: deliveryLog.id, attemptNo: newAttemptNo, error: result.error },
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
