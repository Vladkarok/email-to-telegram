import type { Api } from "grammy";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../db/schema.js";
import { parseEmail } from "./parser.js";
import { cleanEmailBody } from "./cleaner.js";
import { renderEmail } from "./renderer.js";
import { isImageContentType } from "./imageTypes.js";
import { sendTelegramMessage, sendTelegramPhotos } from "../telegram/sender.js";
import {
  findLogsNeedingRetry,
  claimDeliveryLogForRetry,
  updateDeliveryLogStatus,
} from "../db/repos/deliveryLogs.js";
import { insertDeliveryAttempt, countAttemptsByLog } from "../db/repos/deliveryAttempts.js";
import { findAliasById } from "../db/repos/aliases.js";
import { listAttachmentsByDeliveryLogId } from "../db/repos/attachments.js";
import { createAttachmentLink } from "../db/repos/attachmentLinks.js";
import { readRawEmail } from "../storage/disk.js";
import { generateDownloadToken } from "../utils/tokens.js";
import { getLogger } from "../utils/logger.js";

type Db = NodePgDatabase<typeof schema>;

const MAX_RETRIES = 3;
const STALE_DELIVERY_MS = 2 * 60 * 1000;

export async function runRetryWorker(
  db: Db,
  api: Api | null,
  {
    attachmentTtlHours = 24,
    publicBaseUrl = "",
  }: { attachmentTtlHours?: number; publicBaseUrl?: string } = {},
): Promise<void> {
  if (!api) return;

  const log = getLogger();
  const retryableLogs = await findLogsNeedingRetry(db, new Date(Date.now() - STALE_DELIVERY_MS));

  if (retryableLogs.length === 0) return;

  log.info({ count: retryableLogs.length }, "retry worker: processing retryable deliveries");

  for (const deliveryLog of retryableLogs) {
    const claimed = await claimDeliveryLogForRetry(db, deliveryLog.id);
    if (!claimed) continue;

    try {
      await retryDelivery(db, api, deliveryLog, {
        attachmentTtlHours,
        publicBaseUrl,
      });
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

async function retryDelivery(
  db: Db,
  api: Api,
  deliveryLog: { id: string; emailAddressId: string; rawEmailPath: string | null },
  opts: { attachmentTtlHours: number; publicBaseUrl: string },
): Promise<void> {
  const log = getLogger();

  if (!deliveryLog.rawEmailPath) {
    await updateDeliveryLogStatus(db, deliveryLog.id, "permanently_failed");
    return;
  }

  const attempts = await countAttemptsByLog(db, deliveryLog.id);
  if (attempts >= MAX_RETRIES) {
    log.warn({ deliveryLogId: deliveryLog.id, attempts }, "retry worker: max retries reached");
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
    await updateDeliveryLogStatus(db, deliveryLog.id, "permanently_failed");
    return;
  }

  // Re-read and re-parse raw email
  let rawEmail: Buffer;
  try {
    rawEmail = await readRawEmail(deliveryLog.rawEmailPath);
  } catch (err: unknown) {
    log.error({ err, deliveryLogId: deliveryLog.id }, "retry worker: raw email file missing");
    await updateDeliveryLogStatus(db, deliveryLog.id, "permanently_failed");
    return;
  }

  const parsed = await parseEmail(rawEmail, rawEmail.length);
  if (parsed.textBody) {
    parsed.textBody = cleanEmailBody(parsed.textBody);
  }

  const storedAttachments = await listAttachmentsByDeliveryLogId(db, deliveryLog.id);
  const attachmentLinks = await Promise.all(
    storedAttachments.map(async (attachment) => {
      const { token, expiresAt } = generateDownloadToken(attachment.id, opts.attachmentTtlHours);
      await createAttachmentLink(db, attachment.id, token, expiresAt);
      return {
        filename: attachment.originalFilename ?? "attachment",
        sizeBytes: attachment.sizeBytes ?? 0,
        url: `${opts.publicBaseUrl}/dl/${token}`,
      };
    }),
  );
  const imageAttachments = storedAttachments
    .filter((attachment) => isImageContentType(attachment.contentType ?? ""))
    .map((attachment) => ({
      storagePath: attachment.storagePath,
      filename: attachment.originalFilename ?? "attachment",
    }));

  const renderMode = (alias.renderMode ?? "plaintext") as "plaintext" | "html" | "markdown";
  const text = renderEmail(parsed, renderMode, alias.fullAddress, attachmentLinks);
  const parseMode =
    renderMode === "html" ? "HTML" : renderMode === "markdown" ? "MarkdownV2" : undefined;

  const result = await sendTelegramMessage(api, {
    chatId: alias.chatId,
    threadId: alias.messageThreadId ?? null,
    text,
    parseMode,
  });

  const newAttemptNo = attempts + 1;

  await insertDeliveryAttempt(db, {
    deliveryLogId: deliveryLog.id,
    attemptNo: newAttemptNo,
    targetChatId: alias.chatId,
    targetThreadId: alias.messageThreadId ?? null,
    telegramMessageId: result.telegramMessageId ? BigInt(result.telegramMessageId) : null,
    status: result.ok ? "succeeded" : "failed",
    errorText: result.error ?? null,
  });

  if (result.ok) {
    log.info({ deliveryLogId: deliveryLog.id, attemptNo: newAttemptNo }, "retry worker: delivered");
    await updateDeliveryLogStatus(db, deliveryLog.id, "delivered");

    if (imageAttachments.length > 0) {
      await sendTelegramPhotos(api, {
        chatId: alias.chatId,
        threadId: alias.messageThreadId ?? null,
        replyToMessageId: result.telegramMessageId,
        photos: imageAttachments,
      });
    }
  } else if (newAttemptNo >= MAX_RETRIES) {
    log.warn(
      { deliveryLogId: deliveryLog.id, error: result.error },
      "retry worker: permanently failed",
    );
    await updateDeliveryLogStatus(db, deliveryLog.id, "permanently_failed");
  } else {
    log.warn(
      { deliveryLogId: deliveryLog.id, attemptNo: newAttemptNo, error: result.error },
      "retry worker: will retry again",
    );
  }
}
