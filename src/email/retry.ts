import type { Api } from "grammy";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../db/schema.js";
import { deliverQueuedEmail } from "./pipeline.js";
import { queueInboundEmail, rejectionPolicy } from "./inboundAdmission/index.js";
import { refundAcceptedEmail } from "../billing/usageRefund.js";
import { notifyApproachingMonthlyLimit } from "../billing/quotaNotifier.js";
import { parseEmail } from "./parser.js";
import { cleanEmailBody } from "./cleaner.js";
import { isImageContentType, isInlinePhoto } from "./imageTypes.js";
import {
  findLogsNeedingRetry,
  claimDeliveryLogForRetry,
  findDeliveryLogByRawEmailPath,
  closeDeliveryLogPermanentlyFailed,
  resetDeliveryLogAfterError,
} from "../db/repos/deliveryLogs.js";
import {
  countAttemptsByLog,
  countCountedFailedAttemptsByLog,
} from "../db/repos/deliveryAttempts.js";
import { readAttemptRoute } from "./deliveryRoute.js";
import {
  renderAttemptMessage,
  runDeliveryAttempt,
  sendFailureLogFields,
} from "./deliveryAttempt.js";
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
import { pipelineTracker } from "../utils/inFlight.js";
import {
  recordDeliveryLost,
  recordRetryAttempt,
  recordTelegramSendFailure,
} from "../observability/metrics.js";
import { isBotHealthy } from "../telegram/health.js";
import { UNCOUNTED_RETRY_ERROR_CLASSES } from "../telegram/errorClassifier.js";

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
// A pending raw email younger than this may belong to a request that is still
// committing its delivery log; recovering it then races the live request, and
// the loser's duplicate branch deletes the raw file the winner points to.
const PENDING_RAW_MIN_AGE_MS = 2 * 60 * 1000;

export async function runRetryWorker(
  db: Db,
  api: Api | null,
  {
    attachmentTtlHours = 24,
    rawEmailTtlHours = 24,
    publicBaseUrl = "",
    attachmentDir = "",
    rawEmailDir,
    telegramRichMessagesEnabled = true,
    shouldStop = () => false,
  }: {
    attachmentTtlHours?: number;
    rawEmailTtlHours?: number;
    publicBaseUrl?: string;
    attachmentDir?: string;
    rawEmailDir?: string;
    telegramRichMessagesEnabled?: boolean;
    /** Checked before each claim, each pending file and each queueing; true ends the run there. */
    shouldStop?: () => boolean;
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
      telegramRichMessagesEnabled,
      shouldStop,
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
    if (shouldStop()) {
      log.info("retry worker: stopping before the next claim");
      return;
    }
    if (pipelineTracker.isActive(deliveryLog.id)) continue;

    const claimed = await claimDeliveryLogForRetry(db, deliveryLog.id);
    if (!claimed) continue;

    try {
      await pipelineTracker.runFor(deliveryLog.id, () =>
        retryDelivery(db, api, deliveryLog, {
          attachmentTtlHours,
          rawEmailTtlHours,
          publicBaseUrl,
          telegramRichMessagesEnabled,
        }),
      );
    } catch (err: unknown) {
      log.error({ err, deliveryLogId: deliveryLog.id }, "retry worker: unexpected error");
      await resetDeliveryLogAfterError(db, deliveryLog.id).catch((statusErr: unknown) => {
        log.error(
          { err: statusErr, deliveryLogId: deliveryLog.id },
          "retry worker: failed to reset delivery status after error",
        );
      });
    }
  }
}

/** Runs the retry worker for the cron, one run at a time, and stops it at shutdown. */
export interface RetryRunner {
  /** A cron tick: starts a run unless one is still active or a stop was requested. */
  tick(): void;
  /** Stops claiming: the active run ends after the delivery in progress. */
  stop(): void;
  /** Settles when the active run has ended; at once when none is active. */
  activeRun(): Promise<void>;
  isActive(): boolean;
}

export function createRetryRunner(run: (shouldStop: () => boolean) => Promise<void>): RetryRunner {
  let active: Promise<void> | null = null;
  let stopped = false;
  const shouldStop = (): boolean => stopped;

  return {
    tick() {
      if (stopped) return;
      if (active) {
        // A run works through its list in sequence; a second one would claim
        // the same backlog. Newly due logs wait for the next tick after it.
        getLogger().info("retry.run.overlap_skipped");
        return;
      }
      active = run(shouldStop)
        .catch((err: unknown) => {
          getLogger().error({ err }, "retry worker error");
        })
        .finally(() => {
          active = null;
        });
    },
    stop() {
      stopped = true;
    },
    activeRun() {
      return active ?? Promise.resolve();
    },
    isActive() {
      return active !== null;
    },
  };
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
    telegramRichMessagesEnabled: boolean;
    shouldStop: () => boolean;
  },
): Promise<void> {
  const log = getLogger();
  const pendingRawEmails = await listPendingRawEmails(opts.rawEmailDir);

  for (const pendingEmail of pendingRawEmails) {
    if (opts.shouldStop()) {
      log.info("retry worker: stopping before the next pending raw email");
      return;
    }
    // An unreadable timestamp counts as old, so such mail is never stranded.
    const createdAtMs = Date.parse(pendingEmail.createdAt);
    if (Date.now() - createdAtMs < PENDING_RAW_MIN_AGE_MS) continue;
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

      // The lookup and the read awaited; a shutdown that began meanwhile
      // must not queue (and charge) new work.
      if (opts.shouldStop()) {
        log.info("retry worker: stopping before queueing a pending raw email");
        return;
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
        telegramRichMessagesEnabled: opts.telegramRichMessagesEnabled,
      });

      if (!queued.queued) {
        if (rejectionPolicy(queued.result.reason).deleteInRecovery) {
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
  opts: {
    attachmentTtlHours: number;
    rawEmailTtlHours: number;
    publicBaseUrl: string;
    telegramRichMessagesEnabled: boolean;
  },
): Promise<void> {
  const log = getLogger();

  // Marks the log permanently failed and refunds the monthly-quota charge the
  // acceptance path took: the user never received this email, so it must not
  // count against their plan. Counted only when this close ended the log:
  // a log another writer already closed was counted there.
  const closePermanentlyFailed = async (): Promise<void> => {
    const closed = await closeDeliveryLogPermanentlyFailed(db, deliveryLog.id);
    if (!closed) return;
    recordRetryAttempt("permanently_failed");
    recordDeliveryLost("retry");
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
  // Failed photos are matched against every stored image row, not only the
  // inline ones, with the same filename/size defaults as above.
  const fallbackAttachments = storedAttachments
    .filter((attachment) => isImageContentType(attachment.contentType ?? ""))
    .map((attachment) => ({
      attachmentId: attachment.id,
      storagePath: attachment.storagePath,
      filename: attachment.originalFilename ?? "attachment",
      sizeBytes: attachment.sizeBytes ?? 0,
    }));

  const rendered = await renderAttemptMessage(db, {
    privacyMode,
    renderMode: alias.renderMode,
    aliasFullAddress: alias.fullAddress,
    parsed,
    attachmentLinks,
    deliveryLog,
    publicBaseUrl: opts.publicBaseUrl,
    rawEmailTtlHours: opts.rawEmailTtlHours,
  });

  await runDeliveryAttempt(db, api, {
    path: "retry",
    log,
    deliveryLog,
    aliasId: deliveryLog.emailAddressId,
    route,
    attemptNo: attempts + 1,
    message: {
      text: rendered.text,
      parseMode: rendered.parseMode,
      richHtml: rendered.richHtml,
      richIneligibleReason: rendered.richIneligibleReason,
      richMessagesEnabled: opts.telegramRichMessagesEnabled,
    },
    privacyMode,
    photos: imageAttachments,
    fallbackAttachments,
    publicBaseUrl: opts.publicBaseUrl,
    attachmentTtlHours: opts.attachmentTtlHours,
    failedStatus: (disposition) => {
      const countedAfterSend =
        disposition === "retry_counted" ? countedFailures + 1 : countedFailures;
      return disposition === "fail_permanently" || countedAfterSend >= MAX_RETRIES
        ? "permanently_failed"
        : "failed";
    },
    afterCommit: (attempt) => {
      if (!attempt.result.ok) return;
      recordRetryAttempt("succeeded");
      log.info(
        { deliveryLogId: deliveryLog.id, attemptNo: attempt.attemptNo },
        "retry worker: delivered",
      );
    },
    // The retry counts and logs a failed send only after its loss, refund and
    // migration repair.
    afterFailure: (attempt) => {
      if (attempt.status === "permanently_failed") {
        recordRetryAttempt("permanently_failed");
        recordTelegramSendFailure(attempt.result.error);
        log.warn(
          { deliveryLogId: deliveryLog.id, ...sendFailureLogFields(attempt) },
          "retry worker: permanently failed",
        );
      } else {
        recordRetryAttempt("failed");
        recordTelegramSendFailure(attempt.result.error);
        log.warn(
          {
            deliveryLogId: deliveryLog.id,
            attemptNo: attempt.attemptNo,
            ...sendFailureLogFields(attempt),
          },
          "retry worker: will retry again",
        );
      }
    },
  });
}
