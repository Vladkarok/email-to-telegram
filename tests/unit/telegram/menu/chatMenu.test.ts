import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockCtx } from "../../../helpers/mockContext.js";

const mockFindActiveChats = vi.fn();

vi.mock("../../../../src/config.js", () => ({
  loadConfig: () => ({ appMode: "self-hosted" }),
}));

vi.mock("../../../../src/db/repos/chats.js", () => ({
  findActiveChats: (...args: unknown[]): unknown => mockFindActiveChats(...args),
}));

const { sendChatSelectionMenu, editChatSelectionMenu, editChatManagementMenu } =
  await import("../../../../src/telegram/menu/chatMenu.js");

const fakeDb = {} as Parameters<typeof sendChatSelectionMenu>[1];

describe("sendChatSelectionMenu", () => {
  beforeEach(() => vi.clearAllMocks());

  it("replies with 'no chats' message when list is empty", async () => {
    mockFindActiveChats.mockResolvedValue([]);
    const ctx = createMockCtx({ chatType: "private" });
    await sendChatSelectionMenu(ctx, fakeDb);
    expect(ctx.reply).toHaveBeenCalledOnce();
    const text = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as unknown;
    expect(String(text)).toMatch(/No chats/i);
  });

  it("replies with inline keyboard when chats exist", async () => {
    mockFindActiveChats.mockResolvedValue([{ id: -100n, title: "My Group", type: "supergroup" }]);
    const ctx = createMockCtx({ chatType: "private" });
    await sendChatSelectionMenu(ctx, fakeDb);
    expect(ctx.reply).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ reply_markup: expect.anything() as unknown }),
    );
  });
});

describe("editChatSelectionMenu", () => {
  beforeEach(() => vi.clearAllMocks());

  it("edits message with 'no chats' when list is empty", async () => {
    mockFindActiveChats.mockResolvedValue([]);
    const ctx = createMockCtx({ chatType: "private" });
    await editChatSelectionMenu(ctx, fakeDb);
    expect(ctx.editMessageText).toHaveBeenCalledOnce();
    const text = (ctx.editMessageText as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as unknown;
    expect(String(text)).toMatch(/No chats/i);
  });

  it("edits message with keyboard when chats exist", async () => {
    mockFindActiveChats.mockResolvedValue([{ id: -100n, title: "My Group", type: "supergroup" }]);
    const ctx = createMockCtx({ chatType: "private" });
    await editChatSelectionMenu(ctx, fakeDb);
    expect(ctx.editMessageText).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ reply_markup: expect.anything() as unknown }),
    );
  });
});

describe("editChatManagementMenu", () => {
  it("shows New Email and List Emails buttons", async () => {
    const ctx = createMockCtx({ chatType: "private" });
    await editChatManagementMenu(ctx, "-1001234567890", "Test Group");
    expect(ctx.editMessageText).toHaveBeenCalledOnce();
    const [text, opts] = (ctx.editMessageText as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      unknown,
    ];
    expect(text).toContain("Test Group");
    expect(opts).toMatchObject({ parse_mode: "HTML", reply_markup: expect.anything() as unknown });
  });

  it("escapes HTML in chat title", async () => {
    const ctx = createMockCtx({ chatType: "private" });
    await editChatManagementMenu(ctx, "-100", "<script>alert(1)</script>");
    const [text] = (ctx.editMessageText as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(text).not.toContain("<script>");
    expect(text).toContain("&lt;script&gt;");
  });
});
