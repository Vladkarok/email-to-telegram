import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockCtx } from "../../../helpers/mockContext.js";

const mockListAliasesByChat = vi.fn();
const mockFindAliasById = vi.fn();
const mockListAllowRules = vi.fn();

vi.mock("../../../../src/db/repos/aliases.js", () => ({
  listAliasesByChat: (...args: unknown[]): unknown => mockListAliasesByChat(...args),
  findAliasById: (...args: unknown[]): unknown => mockFindAliasById(...args),
}));

vi.mock("../../../../src/db/repos/allowRules.js", () => ({
  listAllowRules: (...args: unknown[]): unknown => mockListAllowRules(...args),
}));

const { editAliasListMenu, editAliasDetailMenu } =
  await import("../../../../src/telegram/menu/aliasMenu.js");

const fakeDb = {} as Parameters<typeof editAliasListMenu>[1];

const fakeAlias = {
  id: "aaaaaaaa-0000-0000-0000-000000000001",
  localPart: "alerts-ab12cd",
  fullAddress: "alerts-ab12cd@example.com",
  chatId: -100n,
  status: "active",
  renderMode: "plaintext",
};

describe("editAliasListMenu", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shows 'no aliases' state with create button when empty", async () => {
    mockListAliasesByChat.mockResolvedValue([]);
    const ctx = createMockCtx({ chatType: "private" });
    await editAliasListMenu(ctx, fakeDb, -100n, "My Chat");
    expect(ctx.editMessageText).toHaveBeenCalledOnce();
    const [text] = (ctx.editMessageText as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(text).toMatch(/No aliases/i);
  });

  it("shows alias buttons when aliases exist", async () => {
    mockListAliasesByChat.mockResolvedValue([fakeAlias]);
    const ctx = createMockCtx({ chatType: "private" });
    await editAliasListMenu(ctx, fakeDb, -100n, "My Chat");
    expect(ctx.editMessageText).toHaveBeenCalledOnce();
    const [text] = (ctx.editMessageText as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(text).toContain("My Chat");
  });
});

describe("editAliasDetailMenu", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shows alias details with allow rules", async () => {
    mockFindAliasById.mockResolvedValue(fakeAlias);
    mockListAllowRules.mockResolvedValue([
      { id: "rule-1", matchType: "domain", matchValue: "github.com" },
    ]);
    const ctx = createMockCtx({ chatType: "private" });
    await editAliasDetailMenu(ctx, fakeDb, fakeAlias.id);
    expect(ctx.editMessageText).toHaveBeenCalledOnce();
    const [text] = (ctx.editMessageText as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(text).toContain(fakeAlias.fullAddress);
    expect(text).toContain("github.com");
  });

  it("shows warning when no allow rules", async () => {
    mockFindAliasById.mockResolvedValue(fakeAlias);
    mockListAllowRules.mockResolvedValue([]);
    const ctx = createMockCtx({ chatType: "private" });
    await editAliasDetailMenu(ctx, fakeDb, fakeAlias.id);
    const [text] = (ctx.editMessageText as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(text).toMatch(/all mail rejected/i);
  });

  it("shows Pause button for active alias", async () => {
    mockFindAliasById.mockResolvedValue({ ...fakeAlias, status: "active" });
    mockListAllowRules.mockResolvedValue([]);
    const ctx = createMockCtx({ chatType: "private" });
    await editAliasDetailMenu(ctx, fakeDb, fakeAlias.id);
    const [, opts] = (ctx.editMessageText as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      { reply_markup: { inline_keyboard: { text: string }[][] } },
    ];
    const buttons = opts.reply_markup.inline_keyboard.flat().map((b) => b.text);
    expect(buttons.some((t) => t.includes("Pause"))).toBe(true);
    expect(buttons.some((t) => t.includes("Resume"))).toBe(false);
  });

  it("shows Resume button for paused alias", async () => {
    mockFindAliasById.mockResolvedValue({ ...fakeAlias, status: "paused" });
    mockListAllowRules.mockResolvedValue([]);
    const ctx = createMockCtx({ chatType: "private" });
    await editAliasDetailMenu(ctx, fakeDb, fakeAlias.id);
    const [, opts] = (ctx.editMessageText as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      { reply_markup: { inline_keyboard: { text: string }[][] } },
    ];
    const buttons = opts.reply_markup.inline_keyboard.flat().map((b) => b.text);
    expect(buttons.some((t) => t.includes("Resume"))).toBe(true);
  });

  it("shows Allow Rules button", async () => {
    mockFindAliasById.mockResolvedValue(fakeAlias);
    mockListAllowRules.mockResolvedValue([]);
    const ctx = createMockCtx({ chatType: "private" });
    await editAliasDetailMenu(ctx, fakeDb, fakeAlias.id);
    const [, opts] = (ctx.editMessageText as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      { reply_markup: { inline_keyboard: { text: string }[][] } },
    ];
    const buttons = opts.reply_markup.inline_keyboard.flat().map((b) => b.text);
    expect(buttons.some((t) => t.includes("Allow Rules"))).toBe(true);
  });

  it("calls answerCallbackQuery when alias is not found", async () => {
    mockFindAliasById.mockResolvedValue(null);
    const ctx = createMockCtx({ chatType: "private" });
    await editAliasDetailMenu(ctx, fakeDb, "nonexistent-id");
    expect(ctx.answerCallbackQuery).toHaveBeenCalled();
    expect(ctx.editMessageText).not.toHaveBeenCalled();
  });
});
