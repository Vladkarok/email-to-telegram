import { InputFile } from "grammy";
import type { Api } from "grammy";
import type { ParseMode } from "@grammyjs/types";
import { getLogger } from "../utils/logger.js";
import { openAttachmentStream } from "../storage/disk.js";
import { recordRichMessage, recordTelegramSendFailure } from "../observability/metrics.js";
import {
  classifyTelegramError,
  describeSendError,
  type TelegramSendFailure,
} from "./errorClassifier.js";

const RETRY_DELAYS_MS = [1000, 2000, 4000];
const MEDIA_GROUP_MAX = 10;
const TELEGRAM_API_TIMEOUT_MS = 30_000;
let richMessageMethodUnavailable = false;

export interface SendOptions {
  chatId: bigint;
  threadId: bigint | null;
  text: string;
  parseMode?: ParseMode;
  /** Safe, preflighted Telegram Rich HTML for the same content as `text`. */
  richHtml?: string;
  /** Runtime kill switch. Defaults to enabled for backward-compatible callers. */
  richMessagesEnabled?: boolean;
}

export interface SendResult {
  ok: boolean;
  telegramMessageId?: number;
  error?: string;
  /** Structured details of the last failure; present whenever ok is false. */
  failure?: TelegramSendFailure;
}

interface RetryOutcome {
  result: SendResult;
  attempts: number;
}

export interface PhotoItem {
  id: string;
  storagePath: string;
  filename: string;
  encryptionMode: string | null;
  wrappedDek: string | null;
  kekKeyId: string | null;
}

export interface SendPhotosOptions {
  chatId: bigint;
  threadId: bigint | null;
  replyToMessageId?: number;
  photos: PhotoItem[];
}

export interface SendPhotosResult {
  ok: boolean;
  failedPhotos: PhotoItem[];
  /**
   * Structured details of the first failure (a migrate failure takes
   * precedence — it aborts the batch); present whenever ok is false.
   */
  failure?: TelegramSendFailure;
}

export async function sendTelegramMessage(api: Api, opts: SendOptions): Promise<SendResult> {
  if (opts.richHtml) {
    if (opts.richMessagesEnabled === false || richMessageMethodUnavailable) {
      recordRichMessage("disabled");
    } else {
      const richAttempt = await sendRichTelegramMessage(api, opts);
      const richResult = richAttempt.result;
      if (richResult.ok) {
        recordRichMessage("success");
        return richResult;
      }

      if (richResult.failure?.code === 404) richMessageMethodUnavailable = true;

      // A prior transient/ambiguous attempt may have been accepted despite a
      // lost acknowledgement. Never change transports after such an attempt.
      if (richAttempt.attempts !== 1 || !shouldUseClassicFallback(richResult.failure)) {
        return richResult;
      }

      recordRichMessage("fallback");
      getLogger().warn(
        safeFailureLogFields("sendRichMessage", richAttempt.attempts, opts, richResult.failure),
        "rich message rejected; using classic fallback",
      );
    }
  }

  return sendClassicTelegramMessage(api, opts);
}

async function sendClassicTelegramMessage(api: Api, opts: SendOptions): Promise<SendResult> {
  const other: {
    parse_mode?: ParseMode;
    message_thread_id?: number;
    link_preview_options: { is_disabled: true };
  } = {
    link_preview_options: { is_disabled: true },
  };
  if (opts.parseMode) {
    other.parse_mode = opts.parseMode;
  }
  if (opts.threadId !== null) {
    other.message_thread_id = Number(opts.threadId);
  }

  const outcome = await sendWithRetries(
    "sendMessage",
    opts,
    () => api.sendMessage(Number(opts.chatId), opts.text, other),
    "sendMessage timed out",
  );
  return outcome.result;
}

async function sendRichTelegramMessage(api: Api, opts: SendOptions): Promise<RetryOutcome> {
  const other: { message_thread_id?: number } = {};
  if (opts.threadId !== null) other.message_thread_id = Number(opts.threadId);

  return sendWithRetries(
    "sendRichMessage",
    opts,
    () =>
      api.sendRichMessage(
        Number(opts.chatId),
        { html: opts.richHtml, skip_entity_detection: true },
        other,
      ),
    "sendRichMessage timed out",
  );
}

async function sendWithRetries(
  method: "sendMessage" | "sendRichMessage",
  opts: SendOptions,
  send: () => Promise<{ message_id: number }>,
  timeoutMessage: string,
): Promise<RetryOutcome> {
  let lastFailure: TelegramSendFailure | null = null;
  let attempts = 0;

  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
    attempts = attempt + 1;
    try {
      const msg = await withTimeout(send(), TELEGRAM_API_TIMEOUT_MS, timeoutMessage);
      return { result: { ok: true, telegramMessageId: msg.message_id }, attempts };
    } catch (err: unknown) {
      lastFailure = describeSendError(err);
      getLogger().warn(
        safeFailureLogFields(method, attempt + 1, opts, lastFailure),
        `${method} failed`,
      );

      // Structured permanent failures cannot be repaired by repeating the
      // same request. Unstructured failures retain the historical retries.
      if (lastFailure.migrateToChatId !== null) break;
      if (lastFailure.code !== null && !lastFailure.transient) break;
      if (attempt < RETRY_DELAYS_MS.length - 1) {
        await sleep(RETRY_DELAYS_MS[attempt] ?? 1000);
      }
    }
  }

  return {
    result: {
      ok: false,
      error: lastFailure?.description ?? "unknown error",
      failure: lastFailure ?? undefined,
    },
    attempts,
  };
}

export async function sendTelegramPhotos(
  api: Api,
  opts: SendPhotosOptions,
): Promise<SendPhotosResult> {
  const log = getLogger();
  const chatId = Number(opts.chatId);
  const failedPhotos: PhotoItem[] = [];
  let failure: TelegramSendFailure | undefined;
  let abortedByMigrate = false;

  for (let i = 0; i < opts.photos.length; i += MEDIA_GROUP_MAX) {
    const chunk = opts.photos.slice(i, i + MEDIA_GROUP_MAX);

    const other: {
      message_thread_id?: number;
      reply_parameters?: { message_id: number };
    } = {};
    if (opts.threadId !== null) other.message_thread_id = Number(opts.threadId);
    if (i === 0 && opts.replyToMessageId !== undefined) {
      other.reply_parameters = { message_id: opts.replyToMessageId };
    }

    // Stream each attachment from disk rather than buffering the whole
    // decrypted file in memory; sendMediaGroup of 10 photos would otherwise
    // hold 10 full buffers at once. openAttachmentStream decrypts to a temp
    // file and returns a read stream + dispose() for cleanup.
    const opened = await Promise.allSettled(
      chunk.map((p) => openAttachmentStream({ ...p, sizeBytes: null })),
    );
    const streams = opened.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    try {
      for (const r of opened) {
        if (r.status === "rejected") throw r.reason;
      }
      if (chunk.length === 1) {
        await withTimeout(
          api.sendPhoto(chatId, new InputFile(streams[0].stream, chunk[0].filename), other),
          TELEGRAM_API_TIMEOUT_MS,
          "sendPhoto timed out",
        );
      } else {
        const media = streams.map((s, idx) => ({
          type: "photo" as const,
          media: new InputFile(s.stream, chunk[idx].filename),
        }));
        await withTimeout(
          api.sendMediaGroup(chatId, media, other),
          TELEGRAM_API_TIMEOUT_MS,
          "sendMediaGroup timed out",
        );
      }
    } catch (err: unknown) {
      const chunkFailure = describeSendError(err);
      failure ??= chunkFailure;
      recordTelegramSendFailure(chunkFailure.description);
      log.error(
        {
          method: chunk.length === 1 ? "sendPhoto" : "sendMediaGroup",
          chatId: String(chatId),
          chunkSize: chunk.length,
          code: chunkFailure.code,
          errorClass: classifyTelegramError(chunkFailure),
          transient: chunkFailure.transient,
          hasMigrationHint: chunkFailure.migrateToChatId !== null,
        },
        "sendPhotos failed",
      );
      failedPhotos.push(...chunk);
      if (chunkFailure.migrateToChatId !== null) {
        // The chat migrated: later chunks can never reach the old id. Fail
        // the remainder of the batch and surface the migrate hint.
        failure = chunkFailure;
        failedPhotos.push(...opts.photos.slice(i + MEDIA_GROUP_MAX));
        abortedByMigrate = true;
      }
    } finally {
      // Release temp files. Idempotent with the stream's own close/error
      // cleanup; covers the case the stream was never consumed (open failed
      // mid-batch, or the send threw before reading).
      for (const s of streams) {
        await s.dispose?.().catch(() => {});
      }
    }
    if (abortedByMigrate) break;
  }

  // `failure` is only ever set in the catch that also pushes to
  // failedPhotos, so no extra guard is needed here.
  return { ok: failedPhotos.length === 0, failedPhotos, failure };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldUseClassicFallback(failure: TelegramSendFailure | undefined): boolean {
  if (!failure || failure.transient || failure.migrateToChatId !== null) return false;
  if (failure.code === 404) return true;
  return (
    failure.code === 400 &&
    classifyTelegramError(failure) === "bad_request" &&
    !isDestinationOrAuthFailure(failure.description)
  );
}

function isDestinationOrAuthFailure(description: string): boolean {
  return /(?:chat|peer|thread|topic).*(?:closed|forbidden|invalid|not found)|(?:blocked|forbidden|not enough rights|write forbidden)/iu.test(
    description,
  );
}

function safeFailureLogFields(
  method: "sendMessage" | "sendRichMessage",
  attempt: number,
  opts: SendOptions,
  failure: TelegramSendFailure | undefined,
): Record<string, unknown> {
  return {
    method,
    attempt,
    chatId: opts.chatId.toString(),
    threadId: opts.threadId?.toString(),
    code: failure?.code ?? null,
    errorClass: classifyTelegramError(failure),
    transient: failure?.transient ?? false,
    hasMigrationHint: failure?.migrateToChatId !== null && failure?.migrateToChatId !== undefined,
  };
}

/** Reset only the process capability latch; exposed for isolated unit tests. */
export function resetRichMessageAvailabilityForTests(): void {
  richMessageMethodUnavailable = false;
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
