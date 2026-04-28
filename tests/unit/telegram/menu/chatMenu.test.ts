import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockCtx } from "../../../helpers/mockContext.js";

const mockLoadConfig = vi.fn(() => ({ appMode: "self-hosted" }));
vi.mock("../../../../src/config.js", () => ({
  loadConfig: (): unknown => mockLoadConfig(),
}));

const mockGetAccessibleChats = vi.fn();
vi.mock("../../../../src/telegram/authorization.js", () => ({
  getAccessibleChats: (...args: unknown[]): unknown => mockGetAccessibleChats(...args),
}));

const mockGetPrimaryOrganizationForUser = vi.fn();
vi.mock("../../../../src/tenant/currentOrganization.js", () => ({
  getPrimaryOrganizationForUser: (...args: unknown[]): unknown =>
    mockGetPrimaryOrganizationForUser(...args),
}));

const mockCountActiveAliasesByOrganization = vi.fn();
vi.mock("../../../../src/db/repos/aliases.js", () => ({
  countActiveAliasesByOrganization: (...args: unknown[]): unknown =>
    mockCountActiveAliasesByOrganization(...args),
  createAlias: vi.fn(),
  findAliasByLocalPart: vi.fn(),
  findAliasById: vi.fn(),
  findAliasesByCreator: vi.fn(),
}));

const { sendChatSelectionMenu, editChatSelectionMenu, editChatManagementMenu } =
  await import("../../../../src/telegram/menu/chatMenu.js");

const fakeDb = {} as Parameters<typeof sendChatSelectionMenu>[1];

const FREE_ORG = {
  id: "org-1",
  planCode: "free" as const,
  subscriptionStatus: "free",
  currentPeriodEnd: null,
};

const ONE_CHAT = [{ id: -100n, title: "My Group", type: "supergroup" }];

describe("sendChatSelectionMenu", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadConfig.mockReturnValue({ appMode: "self-hosted" });
    mockGetAccessibleChats.mockResolvedValue(ONE_CHAT);
  });

  it("replies with 'no chats' message when list is empty", async () => {
    mockGetAccessibleChats.mockResolvedValue([]);
    const ctx = createMockCtx({ chatType: "private" });
    await sendChatSelectionMenu(ctx, fakeDb);
    expect(ctx.reply).toHaveBeenCalledOnce();
    const text = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as unknown;
    expect(String(text)).toMatch(/No chats/i);
  });

  it("replies with inline keyboard when chats exist", async () => {
    const ctx = createMockCtx({ chatType: "private" });
    await sendChatSelectionMenu(ctx, fakeDb);
    expect(ctx.reply).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ reply_markup: expect.anything() as unknown }),
    );
  });

  it("in self-hosted mode does not include a plan/alias footer", async () => {
    mockLoadConfig.mockReturnValue({ appMode: "self-hosted" });
    const ctx = createMockCtx({ chatType: "private" });
    await sendChatSelectionMenu(ctx, fakeDb);
    const [text] = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(text).not.toMatch(/Plan:/i);
    expect(mockGetPrimaryOrganizationForUser).not.toHaveBeenCalled();
  });

  it("in hosted mode appends plan/alias footer when org exists", async () => {
    mockLoadConfig.mockReturnValue({ appMode: "hosted" });
    mockGetPrimaryOrganizationForUser.mockResolvedValue(FREE_ORG);
    mockCountActiveAliasesByOrganization.mockResolvedValue(2);
    const ctx = createMockCtx({ chatType: "private" });
    await sendChatSelectionMenu(ctx, fakeDb);
    const [text] = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(text).toMatch(/Plan:\s*Free/i);
    expect(text).toMatch(/\d+\/3\s*aliases/i);
  });

  it("in hosted mode shows no footer when org fetch fails (silently degrades)", async () => {
    mockLoadConfig.mockReturnValue({ appMode: "hosted" });
    mockGetPrimaryOrganizationForUser.mockRejectedValue(new Error("db error"));
    const ctx = createMockCtx({ chatType: "private" });
    await sendChatSelectionMenu(ctx, fakeDb);
    // Should still reply successfully without crashing
    expect(ctx.reply).toHaveBeenCalledOnce();
    const [text] = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(text).not.toMatch(/Plan:/i);
  });

  it("in hosted mode shows no footer when no org found", async () => {
    mockLoadConfig.mockReturnValue({ appMode: "hosted" });
    mockGetPrimaryOrganizationForUser.mockResolvedValue(null);
    const ctx = createMockCtx({ chatType: "private" });
    await sendChatSelectionMenu(ctx, fakeDb);
    const [text] = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(text).not.toMatch(/Plan:/i);
  });
});

describe("editChatSelectionMenu", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadConfig.mockReturnValue({ appMode: "self-hosted" });
    mockGetAccessibleChats.mockResolvedValue(ONE_CHAT);
  });

  it("edits message with 'no chats' when list is empty", async () => {
    mockGetAccessibleChats.mockResolvedValue([]);
    const ctx = createMockCtx({ chatType: "private" });
    await editChatSelectionMenu(ctx, fakeDb);
    expect(ctx.editMessageText).toHaveBeenCalledOnce();
    const text = (ctx.editMessageText as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as unknown;
    expect(String(text)).toMatch(/No chats/i);
  });

  it("edits message with keyboard when chats exist", async () => {
    const ctx = createMockCtx({ chatType: "private" });
    await editChatSelectionMenu(ctx, fakeDb);
    expect(ctx.editMessageText).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ reply_markup: expect.anything() as unknown }),
    );
  });

  it("in hosted mode appends plan/alias footer when org exists", async () => {
    mockLoadConfig.mockReturnValue({ appMode: "hosted" });
    mockGetPrimaryOrganizationForUser.mockResolvedValue(FREE_ORG);
    mockCountActiveAliasesByOrganization.mockResolvedValue(1);
    const ctx = createMockCtx({ chatType: "private" });
    await editChatSelectionMenu(ctx, fakeDb);
    const [text] = (ctx.editMessageText as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(text).toMatch(/Plan:\s*Free/i);
    expect(text).toMatch(/\d+\/3\s*aliases/i);
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
