/**
 * One delivery attempt, from the text send to the last attachment.
 *
 * The first attempt (pipeline/deliver.ts) and the retry worker (retry.ts)
 * each prepare the message and read the attempt's route (deliveryRoute.ts);
 * everything after that is this module: send the text, classify a failure,
 * persist the attempt row and the log status, count a lost mail and refund
 * it, repair a chat migration, mark the alias as working, send the photos,
 * fall back to download links, and observe the latency.
 *
 * The two paths differ in their metrics, log events and the order some of
 * them run in (see `DeliveryAttemptInput`); those stay with the caller as
 * hooks, and the per-path event names of the shared steps live in
 * `ATTEMPT_EVENTS`.
 */
import type { Api } from "grammy";
import type { Logger } from "pino";
import {
  renderAttachmentFallback,
  renderEmailForDelivery,
  renderPrivacyAlert,
  normalizeRenderMode,
  type AttachmentLink,
  type RenderedEmailForDelivery,
} from "./renderer.js";
import type { ParsedEmail } from "./types.js";
import type { DeliveryRoute } from "./deliveryRoute.js";
import { createPrivacyViewUrl } from "./privacy.js";
import {
  sendTelegramMessage,
  sendTelegramPhotos,
  type PhotoItem,
  type SendOptions,
  type SendResult,
} from "../telegram/sender.js";
import {
  classifyTelegramError,
  retryDispositionForError,
  type RetryDisposition,
  type TelegramErrorClass,
} from "../telegram/errorClassifier.js";
import { repairChatMigration } from "../telegram/chatMigration.js";
import { insertDeliveryAttempt } from "../db/repos/deliveryAttempts.js";
import {
  reopenDeliveryLogAfterMigration,
  settleDeliveryLogAfterSend,
  type DeliverySendOutcome,
} from "../db/repos/deliveryLogs.js";
import { createAttachmentLink } from "../db/repos/attachmentLinks.js";
import { markAliasFirstDelivered } from "../db/repos/aliasActivation.js";
import type { DeliveryLog } from "../db/schema.js";
import { refundAcceptedEmail } from "../billing/usageRefund.js";
import {
  recordDeliveryLatency,
  recordDeliveryLost,
  recordTelegramSendFailure,
  type DeliveryPath,
} from "../observability/metrics.js";
import { generateDownloadToken } from "../utils/tokens.js";
import { retryAsync } from "../utils/retryAsync.js";
import type { Db } from "./pipeline/types.js";

// The Telegram send is irreversible; if persisting its outcome fails the retry
// worker would resend (a duplicate). Retry the persistence a few times before
// giving up so a transient DB blip cannot strand the record.
const POST_SEND_PERSIST_RETRY = { attempts: 3, delaysMs: [200, 1000] } as const;

interface AttemptEvents {
  /** Logged before the persistence error is rethrown; null logs nothing. */
  persistFailed: string | null;
  repairFailed: string;
  markerFailed: string;
  reopenFailed: string;
  abortedForMigration: string;
  fallbackFailed: string;
  secondaryFailed: string;
}

/** Log events of the shared steps; each path keeps the names it always had. */
export const ATTEMPT_EVENTS: Record<DeliveryPath, AttemptEvents> = {
  initial: {
    persistFailed: "delivery.attempt_log_persist_failed",
    repairFailed: "chat.migration_repair_failed",
    markerFailed: "delivery.first_delivered_marker_failed",
    reopenFailed: "delivery.migration_retry_reset_failed",
    abortedForMigration: "delivery.aborted_for_migration",
    fallbackFailed: "image attachment fallback delivery failed",
    secondaryFailed: "image attachment secondary delivery failed",
  },
  retry: {
    persistFailed: null,
    repairFailed: "retry worker: chat.migration_repair_failed",
    markerFailed: "retry worker: first_delivered_marker_failed",
    reopenFailed: "retry worker: migration_retry_reset_failed",
    abortedForMigration: "retry worker: delivery.aborted_for_migration",
    fallbackFailed: "retry worker: image attachment fallback delivery failed",
    secondaryFailed: "retry worker: image attachment secondary delivery failed",
  },
};

/** An image that gets a download link if its photo upload fails. */
export interface FallbackAttachment {
  attachmentId: string;
  storagePath: string;
  filename: string;
  sizeBytes: number;
}

/** The text send's outcome, once its attempt row and log status are committed. */
export interface SettledAttempt {
  attemptNo: number;
  result: SendResult;
  status: DeliverySendOutcome;
  errorClass: TelegramErrorClass | null;
}

export interface DeliveryAttemptInput {
  /** Selects the loss stage, the latency path and the shared steps' log events. */
  path: DeliveryPath;
  log: Logger;
  deliveryLog: Pick<DeliveryLog, "id" | "userId" | "receivedAt">;
  /** The alias whose first-delivered marker a text success sets. */
  aliasId: string;
  /** The attempt's one route: every send and the attempt row use it. */
  route: DeliveryRoute;
  attemptNo: number;
  message: Omit<SendOptions, "chatId" | "threadId">;
  /** Privacy mode sends no photos (and so no fallback links). */
  privacyMode: boolean;
  /** Sent as photos replying to the text, in this order. */
  photos: PhotoItem[];
  /** Candidates for links when photos fail; matched by storage path. */
  fallbackAttachments: FallbackAttachment[];
  publicBaseUrl: string;
  attachmentTtlHours: number;
  /** The status a failed text send leaves the log in. */
  failedStatus(disposition: RetryDisposition): Exclude<DeliverySendOutcome, "delivered">;
  /** Runs once the outcome is committed, before loss, refund and migration repair. */
  afterCommit?(attempt: SettledAttempt): void;
  /** Runs after a failed text send's loss, refund and migration repair. */
  afterFailure?(attempt: SettledAttempt): void;
}

/**
 * `delivered`: the text landed (attachments best-effort). `send_failed`: the
 * text did not land. `chat_migrated`: the text landed, then the chat migrated
 * during the attachments and the log was handed back to the retry worker.
 */
export type DeliveryAttemptResult = "delivered" | "send_failed" | "chat_migrated";

/**
 * Runs one attempt. Throws only when the attempt row and status could not be
 * persisted after the send; the caller owns that error.
 */
export async function runDeliveryAttempt(
  db: Db,
  api: Api,
  input: DeliveryAttemptInput,
): Promise<DeliveryAttemptResult> {
  const { log, deliveryLog, route, path } = input;
  const events = ATTEMPT_EVENTS[path];

  const result = await sendTelegramMessage(api, {
    chatId: route.chatId,
    threadId: route.threadId,
    ...input.message,
  });
  // When Telegram accepted the first message: the delivery latency end.
  const firstMessageAcceptedAt = new Date();

  const errorClass = result.ok ? null : classifyTelegramError(result.failure ?? result.error);
  const status: DeliverySendOutcome = result.ok
    ? "delivered"
    : input.failedStatus(retryDispositionForError(result.failure ?? result.error));

  // Persist the attempt row and the final status atomically, with bounded
  // retries: the send already happened, so a failed write here would leave the
  // log retryable and cause a duplicate send on the next worker cycle.
  try {
    await retryAsync(
      () =>
        db.transaction(async (tx) => {
          const workDb = tx as Db;
          await insertDeliveryAttempt(workDb, {
            deliveryLogId: deliveryLog.id,
            attemptNo: input.attemptNo,
            targetChatId: route.chatId,
            targetThreadId: route.threadId,
            telegramMessageId: result.telegramMessageId ? BigInt(result.telegramMessageId) : null,
            status: result.ok ? "succeeded" : "failed",
            errorText: result.error ?? null,
            errorClass,
          });
          await settleDeliveryLogAfterSend(workDb, deliveryLog.id, status);
        }),
      POST_SEND_PERSIST_RETRY,
    );
  } catch (persistErr: unknown) {
    // The Telegram send already happened. If we can't persist the outcome,
    // the retry worker will redeliver and the user sees a duplicate. Log
    // loudly so this is alertable.
    if (events.persistFailed) {
      log.error(
        {
          err: persistErr,
          deliveryLogId: deliveryLog.id,
          telegramSent: result.ok,
          telegramMessageId: result.telegramMessageId ?? null,
        },
        events.persistFailed,
      );
    }
    throw persistErr;
  }

  const settled: SettledAttempt = { attemptNo: input.attemptNo, result, status, errorClass };
  input.afterCommit?.(settled);

  const repair = async (newChatId: bigint): Promise<void> => {
    await repairChatMigration(db, api, route.chatId, newChatId).catch((repairErr: unknown) => {
      log.error({ err: repairErr, deliveryLogId: deliveryLog.id }, events.repairFailed);
    });
  };

  if (!result.ok) {
    if (status === "permanently_failed") {
      // The status write above succeeded (it throws otherwise).
      recordDeliveryLost(path);
      // The user never received this email; give the monthly-quota charge
      // from acceptance back.
      await refundAcceptedEmail(db, {
        deliveryLogId: deliveryLog.id,
        userId: deliveryLog.userId,
        receivedAt: deliveryLog.receivedAt,
      });
    }
    // The chat migrated mid-attempt: repair the alias routing so the retry
    // (status stayed "failed", uncounted) lands on the new id. Repair failure
    // keeps the delivery retryable — never rethrow.
    if (result.failure?.migrateToChatId != null) {
      await repair(result.failure.migrateToChatId);
    }
    input.afterFailure?.(settled);
    return "send_failed";
  }

  // The text landed and its success is persisted: the alias is working.
  // Best-effort; a failed write is reconciled by the cleanup loop from the
  // succeeded attempt, and never touches this delivery.
  try {
    await markAliasFirstDelivered(db, input.aliasId);
  } catch (markErr: unknown) {
    log.warn(
      { err: markErr, deliveryLogId: deliveryLog.id, aliasId: input.aliasId },
      events.markerFailed,
    );
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
  const abortAttemptForMigration = async (newChatId: bigint): Promise<"chat_migrated"> => {
    await repair(newChatId);
    // Back to retryable. The attempt row stays `succeeded`, so this does
    // not consume the bounded retry budget and cannot trigger a refund.
    await reopenDeliveryLogAfterMigration(db, deliveryLog.id).catch((statusErr: unknown) => {
      log.error({ err: statusErr, deliveryLogId: deliveryLog.id }, events.reopenFailed);
    });
    log.warn(
      { deliveryLogId: deliveryLog.id, oldChatId: route.chatId.toString() },
      events.abortedForMigration,
    );
    return "chat_migrated";
  };

  // Send image attachments as Telegram photos (replied to the text message)
  if (!input.privacyMode && input.photos.length > 0) {
    try {
      const photoResult = await sendTelegramPhotos(api, {
        chatId: route.chatId,
        threadId: route.threadId,
        replyToMessageId: result.telegramMessageId,
        photos: input.photos,
      });

      const photoMigrateTo = photoResult.failure?.migrateToChatId ?? null;
      if (photoMigrateTo != null) {
        return await abortAttemptForMigration(photoMigrateTo);
      } else if (photoResult.failedPhotos.length > 0) {
        const failedPaths = new Set(photoResult.failedPhotos.map((photo) => photo.storagePath));
        const fallbackLinks: AttachmentLink[] = await Promise.all(
          input.fallbackAttachments
            .filter((attachment) => failedPaths.has(attachment.storagePath))
            .map(async (attachment) => {
              const { token, expiresAt } = generateDownloadToken(
                attachment.attachmentId,
                input.attachmentTtlHours,
              );
              await createAttachmentLink(db, attachment.attachmentId, token, expiresAt);
              return {
                filename: attachment.filename,
                sizeBytes: attachment.sizeBytes,
                url: `${input.publicBaseUrl}/dl/${token}`,
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
            events.fallbackFailed,
          );
          // The upgrade can just as easily land on this last send.
          if (fallbackResult.failure?.migrateToChatId != null) {
            return await abortAttemptForMigration(fallbackResult.failure.migrateToChatId);
          }
        }
      }
    } catch (err: unknown) {
      log.error({ err, deliveryLogId: deliveryLog.id }, events.secondaryFailed);
    }
  }

  recordDeliveryLatency(path, deliveryLog.receivedAt, firstMessageAcceptedAt);
  return "delivered";
}

/** The failure fields both paths log for a failed text send. */
export function sendFailureLogFields(attempt: SettledAttempt): {
  code: number | null;
  errorClass: TelegramErrorClass | null;
  transient: boolean;
  hasMigrationHint: boolean;
} {
  const { failure } = attempt.result;
  return {
    code: failure?.code ?? null,
    errorClass: attempt.errorClass,
    transient: failure?.transient ?? false,
    hasMigrationHint: failure?.migrateToChatId != null,
  };
}

/**
 * Renders the attempt's text: the email itself, or in privacy mode an alert
 * with a one-time view link that expires with the raw email.
 */
export async function renderAttemptMessage(
  db: Db,
  input: {
    privacyMode: boolean;
    renderMode: string | null | undefined;
    aliasFullAddress: string;
    parsed: ParsedEmail;
    attachmentLinks: AttachmentLink[];
    deliveryLog: Pick<DeliveryLog, "id" | "rawEmailPath" | "receivedAt">;
    publicBaseUrl: string;
    rawEmailTtlHours: number;
  },
): Promise<RenderedEmailForDelivery> {
  const renderMode = normalizeRenderMode(input.renderMode);
  if (!input.privacyMode) {
    return renderEmailForDelivery(
      input.parsed,
      renderMode,
      input.aliasFullAddress,
      input.attachmentLinks,
    );
  }

  const { deliveryLog, parsed } = input;
  if (!deliveryLog.rawEmailPath) {
    throw new Error("privacy mode requires a durable raw email path");
  }
  const viewUrl = await createPrivacyViewUrl(
    db,
    deliveryLog.id,
    input.publicBaseUrl,
    new Date(deliveryLog.receivedAt.getTime() + input.rawEmailTtlHours * 60 * 60 * 1000),
  );
  return {
    text: renderPrivacyAlert(
      parsed,
      input.aliasFullAddress,
      viewUrl,
      parsed.attachments.length > 0,
    ),
    parseMode: "HTML",
    richHtml: undefined,
  };
}
