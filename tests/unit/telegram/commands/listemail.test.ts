import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockCtx } from "../../../helpers/mockContext.js";

vi.mock("../../../../src/db/client.js", () => ({ getDb: vi.fn(() => ({})) }));

const mockListAliasesByChat = vi.fn();
const mockFindAliasesByCreator = vi.fn();
const mockFindChatById = vi.fn();

vi.mock("../../../../src/db/repos/aliases.js", () => ({
  listAliasesByChat: (...args: unknown[]): unknown => mockListAliasesByChat(...args),
  findAliasesByCreator: (...args: unknown[]): unknown => mockFindAliasesByCreator(...args),
}));

vi.mock("../../../../src/db/repos/chats.js", () => ({
  findChatById: (...args: unknown[]): unknown => mockFindChatById(...args),
}));

const { listemailHandler } = await import("../../../../src/telegram/commands/listemail.js");

describe("/listemail in group chat", () => {
  beforeEach(() => vi.clearAllMocks());

  it("replies with 'no aliases' when chat has none", async () => {
    mockListAliasesByChat.mockResolvedValue([]);
    const ctx = createMockCtx({ chatType: "supergroup" });
    await listemailHandler(ctx);
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("No aliases"));
  });

  it("lists aliases with full address and render mode", async () => {
    mockListAliasesByChat.mockResolvedValue([
      { fullAddress: "alerts@example.com", status: "active", renderMode: "html" },
      { fullAddress: "news@example.com", status: "paused", renderMode: "plaintext" },
    ]);
    const ctx = createMockCtx({ chatType: "supergroup" });
    await listemailHandler(ctx);
    const call = ctx.reply.mock.calls[0] as [string, unknown];
    expect(call[0]).toContain("alerts@example.com");
    expect(call[0]).toContain("news@example.com");
  });
});

describe("/listemail in private chat (DM)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shows 'no aliases' when user has none", async () => {
    mockFindAliasesByCreator.mockResolvedValue([]);
    const ctx = createMockCtx({ chatType: "private" });
    await listemailHandler(ctx);
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("No aliases"));
  });

  it("groups aliases by chatId and shows chat title", async () => {
    mockFindAliasesByCreator.mockResolvedValue([
      {
        chatId: -100n,
        fullAddress: "alerts@example.com",
        status: "active",
        renderMode: "plaintext",
      },
      {
        chatId: -100n,
        fullAddress: "news@example.com",
        status: "paused",
        renderMode: "html",
      },
      {
        chatId: -200n,
        fullAddress: "work@example.com",
        status: "active",
        renderMode: "plaintext",
      },
    ]);
    mockFindChatById.mockImplementation((_db: unknown, id: bigint) => {
      if (id === -100n) return Promise.resolve({ title: "My Group", type: "supergroup" });
      if (id === -200n) return Promise.resolve({ title: "Work Chat", type: "supergroup" });
      return Promise.resolve(null);
    });

    const ctx = createMockCtx({ chatType: "private" });
    await listemailHandler(ctx);

    expect(ctx.reply).toHaveBeenCalledOnce();
    const [text] = ctx.reply.mock.calls[0] as [string];
    expect(text).toContain("My Group");
    expect(text).toContain("Work Chat");
    expect(text).toContain("alerts@example.com");
    expect(text).toContain("work@example.com");
  });

  it("falls back to chatId when chat not found", async () => {
    mockFindAliasesByCreator.mockResolvedValue([
      { chatId: -999n, fullAddress: "x@example.com", status: "active", renderMode: "plaintext" },
    ]);
    mockFindChatById.mockResolvedValue(null);

    const ctx = createMockCtx({ chatType: "private" });
    await listemailHandler(ctx);

    const [text] = ctx.reply.mock.calls[0] as [string];
    expect(text).toContain("-999");
  });
});
