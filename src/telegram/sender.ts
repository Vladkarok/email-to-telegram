import type { Api } from "grammy";
import type { ParseMode } from "@grammyjs/types";
import { getLogger } from "../utils/logger.js";

const RETRY_DELAYS_MS = [1000, 2000, 4000];

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
