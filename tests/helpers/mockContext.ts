import { vi } from "vitest";
import type { Context, CommandContext } from "grammy";

export interface MockCtxOptions {
  fromId?: number;
  username?: string;
  chatId?: number;
  chatType?: "private" | "group" | "supergroup" | "channel";
  messageThreadId?: number | null;
  text?: string;
  /** Parsed command argument (everything after the command name) */
  commandMatch?: string;
}

export type MockCtx = CommandContext<Context> & {
  reply: ReturnType<typeof vi.fn>;
};

export function createMockCtx(opts: MockCtxOptions = {}): MockCtx {
  const fromId = opts.fromId ?? 123456789;
  const chatId = opts.chatId ?? (opts.chatType === "private" ? fromId : -1001234567890);

  const ctx = {
    from: {
      id: fromId,
      username: opts.username ?? "testuser",
      first_name: "Test",
      is_bot: false,
    },
    chat: {
      id: chatId,
      type: opts.chatType ?? "supergroup",
    },
    message: {
      message_id: 1,
      message_thread_id: opts.messageThreadId ?? undefined,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: opts.chatType ?? "supergroup" },
      from: { id: fromId, username: opts.username ?? "testuser", is_bot: false },
      text: opts.text ?? "/cmd",
    },
    match: opts.commandMatch ?? "",
    reply: vi.fn().mockResolvedValue({ message_id: 99 }),
    replyWithHTML: vi.fn().mockResolvedValue({ message_id: 99 }),
    answerCallbackQuery: vi.fn().mockResolvedValue(true),
    api: {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 99 }),
    },
  } as unknown as MockCtx;

  return ctx;
}
