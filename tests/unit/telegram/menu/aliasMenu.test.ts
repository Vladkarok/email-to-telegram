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

const mockFindChatById = vi.fn();
vi.mock("../../../../src/db/repos/chats.js", () => ({
  findChatById: (...args: unknown[]): unknown => mockFindChatById(...args),
}));

const mockCanManageAlias = vi.fn();
vi.mock("../../../../src/telegram/authorization.js", () => ({
  canManageAlias: (...args: unknown[]): unknown => mockCanManageAlias(...args),
}));

const { editAliasListMenu, editAliasDetailMenu, sendAliasDetailMenu, editAliasDeleteConfirmMenu } =
  await import("../../../../src/telegram/menu/aliasMenu.js");

const fakeDb = {} as Parameters<typeof editAliasListMenu>[1];

const fakeAlias = {
  id: "aaaaaaaa-0000-0000-0000-000000000001",
  localPart: "alerts-ab12cd",
  fullAddress: "alerts-ab12cd@example.com",
  chatId: -100n,
  status: "active",
  renderMode: "plaintext",
  privacyModeEnabled: false,
  bodyDedupEnabled: false,
  routingVersion: 0,
};

describe("editAliasListMenu", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCanManageAlias.mockResolvedValue(true);
  });

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

  it("filters aliases the user cannot manage", async () => {
    mockListAliasesByChat.mockResolvedValue([
      fakeAlias,
      {
        ...fakeAlias,
        id: "aaaaaaaa-0000-0000-0000-000000000002",
        localPart: "hidden-ab12cd",
      },
    ]);
    mockCanManageAlias.mockImplementation(
      (_db: unknown, _api: unknown, _userId: number, id: string) =>
        Promise.resolve(id === fakeAlias.id),
    );
    const ctx = createMockCtx({ chatType: "private" });

    await editAliasListMenu(ctx, fakeDb, -100n, "My Chat");

    const [, opts] = (ctx.editMessageText as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      { reply_markup: { inline_keyboard: { text: string }[][] } },
    ];
    const buttons = opts.reply_markup.inline_keyboard.flat().map((b) => b.text);
    expect(buttons.some((text) => text.includes("alerts-ab12cd"))).toBe(true);
    expect(buttons.some((text) => text.includes("hidden-ab12cd"))).toBe(false);
  });
});

describe("editAliasDetailMenu", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: a plain group, so no topic hint unless a test opts in.
    mockFindChatById.mockResolvedValue({ id: -100n, title: "My Chat", type: "group" });
  });

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
    expect(text).toContain("Privacy mode: <code>off</code>");
    expect(text).toContain("Body dedup: <code>off</code>");
  });

  it("shows warning when no allow rules", async () => {
    mockFindAliasById.mockResolvedValue(fakeAlias);
    mockListAllowRules.mockResolvedValue([]);
    const ctx = createMockCtx({ chatType: "private" });
    await editAliasDetailMenu(ctx, fakeDb, fakeAlias.id);
    const [text] = (ctx.editMessageText as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(text).toMatch(/all mail rejected/i);
  });

  it("hints how to set a topic when the alias lives in a supergroup, in General", async () => {
    mockFindAliasById.mockResolvedValue({ ...fakeAlias, messageThreadId: null });
    mockListAllowRules.mockResolvedValue([]);
    mockFindChatById.mockResolvedValue({ id: -100n, title: "Forum", type: "supergroup" });
    // Opened from a DM / list view, not from inside a topic.
    const ctx = createMockCtx({ chatType: "private" });

    await editAliasDetailMenu(ctx, fakeDb, fakeAlias.id);

    const [text] = (ctx.editMessageText as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(text).toMatch(/topic/i);
    expect(text).toContain("/listemail");
  });

  it("does not hint for a plain group", async () => {
    mockFindAliasById.mockResolvedValue({ ...fakeAlias, messageThreadId: null });
    mockListAllowRules.mockResolvedValue([]);
    mockFindChatById.mockResolvedValue({ id: -100n, title: "Group", type: "group" });
    const ctx = createMockCtx({ chatType: "private" });

    await editAliasDetailMenu(ctx, fakeDb, fakeAlias.id);

    const [text] = (ctx.editMessageText as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(text).not.toContain("/listemail");
  });

  it("does not hint when the alias already delivers to a topic", async () => {
    mockFindAliasById.mockResolvedValue({ ...fakeAlias, messageThreadId: 7n });
    mockListAllowRules.mockResolvedValue([]);
    mockFindChatById.mockResolvedValue({ id: -100n, title: "Forum", type: "supergroup" });
    const ctx = createMockCtx({ chatType: "private" });

    await editAliasDetailMenu(ctx, fakeDb, fakeAlias.id);

    const [text] = (ctx.editMessageText as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(text).not.toContain("/listemail");
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

  it("shows Allow Rules and Settings buttons", async () => {
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
    expect(buttons.some((t) => t.includes("Settings"))).toBe(true);
  });

  it("calls answerCallbackQuery when alias is not found", async () => {
    mockFindAliasById.mockResolvedValue(null);
    const ctx = createMockCtx({ chatType: "private" });
    await editAliasDetailMenu(ctx, fakeDb, "nonexistent-id");
    expect(ctx.answerCallbackQuery).toHaveBeenCalled();
    expect(ctx.editMessageText).not.toHaveBeenCalled();
  });

  it("can send alias details as a fresh bottom message", async () => {
    mockFindAliasById.mockResolvedValue({ ...fakeAlias, label: "Ops Alerts" });
    mockListAllowRules.mockResolvedValue([]);
    const ctx = createMockCtx({ chatType: "private" });

    await sendAliasDetailMenu(ctx, fakeDb, fakeAlias.id);

    expect(ctx.reply).toHaveBeenCalledOnce();
    const [text, opts] = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      { reply_markup: { inline_keyboard: { text: string }[][] } },
    ];
    expect(text).toContain("Ops Alerts");
    const buttons = opts.reply_markup.inline_keyboard.flat().map((b) => b.text);
    expect(buttons.some((t) => t.includes("Edit Label"))).toBe(true);
  });
});

describe("editAliasDeleteConfirmMenu", () => {
  beforeEach(() => vi.clearAllMocks());

  it("asks for confirmation before deleting an alias", async () => {
    mockFindAliasById.mockResolvedValue(fakeAlias);
    const ctx = createMockCtx({ chatType: "private" });

    await editAliasDeleteConfirmMenu(ctx, fakeDb, fakeAlias.id);

    expect(ctx.editMessageText).toHaveBeenCalledOnce();
    const [text, opts] = (ctx.editMessageText as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      { reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] } },
    ];
    expect(text).toContain(fakeAlias.fullAddress);
    expect(text).toMatch(/delete this email alias/i);
    const buttons = opts.reply_markup.inline_keyboard.flat();
    // The confirm button carries the routing version it was rendered against,
    // so a delete confirmed on a pre-move view loses to the move.
    expect(
      buttons.some(
        (button) => button.callback_data === `adc:${fakeAlias.id}:${fakeAlias.routingVersion ?? 0}`,
      ),
    ).toBe(true);
    expect(buttons.some((button) => button.callback_data === `adx:${fakeAlias.id}`)).toBe(true);
  });
});
