import { InputFile } from "grammy";
import type { Api } from "grammy";
import type { ParseMode } from "@grammyjs/types";
import { readFile } from "fs/promises";
import { getLogger } from "../utils/logger.js";

const RETRY_DELAYS_MS = [1000, 2000, 4000];
const MEDIA_GROUP_MAX = 10;

export interface SendOptions {
  chatId: bigint;
  threadId: bigint | null;
  text: string;
  parseMode?: ParseMode;
}

export interface SendResult {
  ok: boolean;
  telegramMessageId?: number;
  error?: string;
}

export interface PhotoItem {
  storagePath: string;
  filename: string;
}

export interface SendPhotosOptions {
  chatId: bigint;
  threadId: bigint | null;
  replyToMessageId?: number;
  photos: PhotoItem[];
}

export async function sendTelegramMessage(api: Api, opts: SendOptions): Promise<SendResult> {
  const other: { parse_mode?: ParseMode; message_thread_id?: number } = {};
  if (opts.parseMode) {
    other.parse_mode = opts.parseMode;
  }
  if (opts.threadId !== null) {
    other.message_thread_id = Number(opts.threadId);
  }

  let lastError: string = "unknown error";

  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
    try {
      const msg = await api.sendMessage(Number(opts.chatId), opts.text, other);
      return { ok: true, telegramMessageId: msg.message_id };
    } catch (err: unknown) {
      lastError = err instanceof Error ? err.message : String(err);
      getLogger().warn({ attempt, chatId: opts.chatId.toString(), err }, "sendMessage failed");
      if (attempt < RETRY_DELAYS_MS.length - 1) {
        await sleep(RETRY_DELAYS_MS[attempt] ?? 1000);
      }
    }
  }

  return { ok: false, error: lastError };
}

export async function sendTelegramPhotos(api: Api, opts: SendPhotosOptions): Promise<void> {
  const log = getLogger();
  const chatId = Number(opts.chatId);

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

    try {
      if (chunk.length === 1) {
        const photo = chunk[0];
        const buf = await readFile(photo.storagePath);
        await api.sendPhoto(chatId, new InputFile(buf, photo.filename), other);
      } else {
        const media = await Promise.all(
          chunk.map(async (p) => {
            const buf = await readFile(p.storagePath);
            return { type: "photo" as const, media: new InputFile(buf, p.filename) };
          }),
        );
        await api.sendMediaGroup(chatId, media, other);
      }
    } catch (err: unknown) {
      log.error({ err, chatId, chunk: chunk.map((p) => p.filename) }, "sendPhotos failed");
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
