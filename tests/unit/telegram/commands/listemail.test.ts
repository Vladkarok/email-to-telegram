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

const mockCanManageAlias = vi.fn();
const mockCanManageChat = vi.fn();
vi.mock("../../../../src/telegram/authorization.js", () => ({
  canManageAlias: (...args: unknown[]): unknown => mockCanManageAlias(...args),
  canManageChat: (...args: unknown[]): unknown => mockCanManageChat(...args),
}));

const { listemailHandler } = await import("../../../../src/telegram/commands/listemail.js");

describe("/listemail in group chat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCanManageAlias.mockResolvedValue(true);
    mockCanManageChat.mockResolvedValue(true);
  });

  it("replies with 'no aliases' when chat has none", async () => {
    mockListAliasesByChat.mockResolvedValue([]);
    const ctx = createMockCtx({ chatType: "supergroup" });
    await listemailHandler(ctx);
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("No aliases"));
  });

  it("lists aliases with full address and render mode", async () => {
    mockListAliasesByChat.mockResolvedValue([
      { id: "alias-1", fullAddress: "alerts@example.com", status: "active", renderMode: "html" },
      {
        id: "alias-2",
        fullAddress: "news@example.com",
        status: "paused",
        renderMode: "plaintext",
      },
    ]);
    const ctx = createMockCtx({ chatType: "supergroup" });
    await listemailHandler(ctx);
    const call = ctx.reply.mock.calls[0] as [string, unknown];
    expect(call[0]).toContain("alerts@example.com");
    expect(call[0]).toContain("news@example.com");
  });

  it("denies group listing when the user cannot manage the chat", async () => {
    mockCanManageChat.mockResolvedValue(false);
    const ctx = createMockCtx({ chatType: "supergroup" });

    await listemailHandler(ctx);

    expect(ctx.reply).toHaveBeenCalledWith("⛔ Access denied.");
    expect(mockListAliasesByChat).not.toHaveBeenCalled();
  });

  it("filters chat aliases the user cannot manage", async () => {
    mockListAliasesByChat.mockResolvedValue([
      {
        id: "alias-visible",
        fullAddress: "visible@example.com",
        status: "active",
        renderMode: "plaintext",
      },
      {
        id: "alias-hidden",
        fullAddress: "hidden@example.com",
        status: "active",
        renderMode: "plaintext",
      },
    ]);
    mockCanManageAlias.mockImplementation(
      (_db: unknown, _api: unknown, _userId: number, id: string) =>
        Promise.resolve(id === "alias-visible"),
    );
    const ctx = createMockCtx({ chatType: "supergroup" });

    await listemailHandler(ctx);

    const [text] = ctx.reply.mock.calls[0] as [string];
    expect(text).toContain("visible@example.com");
    expect(text).not.toContain("hidden@example.com");
  });
});

describe("/listemail in private chat (DM)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCanManageAlias.mockResolvedValue(true);
    mockCanManageChat.mockResolvedValue(true);
  });

  it("shows 'no aliases' when user has none", async () => {
    mockFindAliasesByCreator.mockResolvedValue([]);
    const ctx = createMockCtx({ chatType: "private" });
    await listemailHandler(ctx);
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("No aliases"));
  });

  it("groups aliases by chatId and shows chat title", async () => {
    mockFindAliasesByCreator.mockResolvedValue([
      {
        id: "alias-1",
        chatId: -100n,
        fullAddress: "alerts@example.com",
        status: "active",
        renderMode: "plaintext",
      },
      {
        id: "alias-2",
        chatId: -100n,
        fullAddress: "news@example.com",
        status: "paused",
        renderMode: "html",
      },
      {
        id: "alias-3",
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
      {
        id: "alias-1",
        chatId: -999n,
        fullAddress: "x@example.com",
        status: "active",
        renderMode: "plaintext",
      },
    ]);
    mockFindChatById.mockResolvedValue(null);

    const ctx = createMockCtx({ chatType: "private" });
    await listemailHandler(ctx);

    const [text] = ctx.reply.mock.calls[0] as [string];
    expect(text).toContain("-999");
  });

  it("filters aliases the user can no longer manage", async () => {
    mockFindAliasesByCreator.mockResolvedValue([
      {
        id: "alias-visible",
        chatId: -100n,
        fullAddress: "visible@example.com",
        status: "active",
        renderMode: "plaintext",
      },
      {
        id: "alias-hidden",
        chatId: -200n,
        fullAddress: "hidden@example.com",
        status: "active",
        renderMode: "plaintext",
      },
    ]);
    mockCanManageAlias.mockImplementation(
      (_db: unknown, _api: unknown, _userId: number, id: string) =>
        Promise.resolve(id === "alias-visible"),
    );
    mockFindChatById.mockResolvedValue({ title: "My Group", type: "supergroup" });

    const ctx = createMockCtx({ chatType: "private" });
    await listemailHandler(ctx);

    const [text] = ctx.reply.mock.calls[0] as [string];
    expect(text).toContain("visible@example.com");
    expect(text).not.toContain("hidden@example.com");
  });
});
