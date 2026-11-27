/**
 * The one fake in the scenario suite: a real grammY `Api` whose transformer
 * answers every call itself, so nothing reaches the network. Each call is
 * recorded with its payload and the bytes of any uploaded file; planned
 * failures answer the next matching call(s) with a Bot API error, which
 * grammY turns into the same GrammyError a real Telegram answer would.
 */
import { Api, InputFile } from "grammy";

export interface UploadedFile {
  /** Payload field the file was sent in (`photo`, or `media[0]` in a media group). */
  field: string;
  filename: string | undefined;
  bytes: Buffer;
}

export interface TelegramCall {
  method: string;
  /** `chat_id` as sent (grammY sends numbers or strings). */
  chatId: string | undefined;
  payload: Record<string, unknown>;
  files: UploadedFile[];
  /** The message id answered for a sent message; undefined for failures and non-messages. */
  messageId?: number;
}

export interface TelegramErrorReply {
  error_code: number;
  description: string;
  parameters?: { retry_after?: number; migrate_to_chat_id?: number };
}

export const TELEGRAM_ERRORS = {
  floodWait: {
    error_code: 429,
    description: "Too Many Requests: retry after 1",
    parameters: { retry_after: 1 },
  },
  botKicked: {
    error_code: 403,
    description: "Forbidden: bot was kicked from the group chat",
  },
  migrated: (newChatId: bigint): TelegramErrorReply => ({
    error_code: 400,
    description: "Bad Request: group chat was upgraded to a supergroup chat",
    parameters: { migrate_to_chat_id: Number(newChatId) },
  }),
} satisfies Record<string, TelegramErrorReply | ((chatId: bigint) => TelegramErrorReply)>;

interface PlannedFailure {
  method: string;
  chatId: string | undefined;
  remaining: number;
  reply: TelegramErrorReply;
}

const MESSAGE_METHODS = new Set(["sendMessage", "sendRichMessage", "sendPhoto", "sendDocument"]);

export class FakeTelegram {
  readonly api: Api;
  readonly calls: TelegramCall[] = [];
  private failures: PlannedFailure[] = [];
  private nextMessageId = 100;

  constructor() {
    this.api = new Api("123456:scenario-fake-token");
    this.api.config.use((_prev, method, payload) =>
      this.handle(method, payload as Record<string, unknown>),
    );
  }

  /** Answers the next `times` calls to `method` (optionally only for `chatId`) with `reply`. */
  failNext(
    method: string,
    reply: TelegramErrorReply,
    { times = 1, chatId }: { times?: number; chatId?: bigint } = {},
  ): void {
    this.failures.push({ method, chatId: chatId?.toString(), remaining: times, reply });
  }

  callsTo(method: string, chatId?: bigint): TelegramCall[] {
    return this.calls.filter(
      (call) =>
        call.method === method && (chatId === undefined || call.chatId === chatId.toString()),
    );
  }

  /** Every call addressed to `chatId`, whatever the method. */
  callsToChat(chatId: bigint): TelegramCall[] {
    return this.calls.filter((call) => call.chatId === chatId.toString());
  }

  reset(): void {
    this.calls.length = 0;
    this.failures = [];
  }

  // grammY's transformer type is generic over the method; the fake answers
  // every method with the same loosely typed envelope.
  private async handle(method: string, payload: Record<string, unknown>): Promise<never> {
    const rawChatId = payload["chat_id"];
    const chatId =
      typeof rawChatId === "number" || typeof rawChatId === "string"
        ? String(rawChatId)
        : undefined;
    const files = await collectFiles(payload);
    const call: TelegramCall = { method, chatId, payload: withoutFiles(payload), files };
    this.calls.push(call);

    const failure = this.failures.find(
      (f) =>
        f.remaining > 0 && f.method === method && (f.chatId === undefined || f.chatId === chatId),
    );
    if (failure) {
      failure.remaining--;
      return { ok: false, ...failure.reply } as never;
    }

    if (MESSAGE_METHODS.has(method)) {
      call.messageId = this.nextMessageId++;
      return {
        ok: true,
        result: {
          message_id: call.messageId,
          date: Math.floor(Date.now() / 1000),
          chat: { id: Number(chatId), type: "supergroup", title: "Scenario chat" },
          ...(typeof payload["text"] === "string" ? { text: payload["text"] } : {}),
        },
      } as never;
    }
    if (method === "getChat") {
      return {
        ok: true,
        result: { id: Number(chatId), type: "supergroup", title: "Migrated chat" },
      } as never;
    }
    return { ok: true, result: true } as never;
  }
}

async function readInputFile(file: InputFile): Promise<Buffer> {
  const raw = await file.toRaw();
  if (raw instanceof Uint8Array) return Buffer.from(raw);
  const chunks: Buffer[] = [];
  for await (const chunk of raw as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/** Reads every InputFile in the payload (top-level fields and media-group items). */
async function collectFiles(payload: Record<string, unknown>): Promise<UploadedFile[]> {
  const files: UploadedFile[] = [];
  for (const [field, value] of Object.entries(payload)) {
    if (value instanceof InputFile) {
      files.push({ field, filename: value.filename, bytes: await readInputFile(value) });
    } else if (Array.isArray(value)) {
      for (const [index, item] of value.entries()) {
        const media = (item as { media?: unknown } | null)?.media;
        if (media instanceof InputFile) {
          files.push({
            field: `${field}[${index}]`,
            filename: media.filename,
            bytes: await readInputFile(media),
          });
        }
      }
    }
  }
  return files;
}

function withoutFiles(payload: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(payload).filter(([, value]) => !(value instanceof InputFile)),
  );
}
