import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockCtx } from "../../../helpers/mockContext.js";

vi.mock("../../../../src/db/client.js", () => ({ getDb: vi.fn(() => ({})) }));

const mockCreateAlias = vi.fn();
vi.mock("../../../../src/db/repos/aliases.js", () => ({
  createAlias: (...args: unknown[]): unknown => mockCreateAlias(...args),
  findAliasByLocalPart: vi.fn().mockResolvedValue(null),
  findAliasById: vi.fn().mockResolvedValue(null),
  findAliasesByCreator: vi.fn().mockResolvedValue([]),
}));

const mockFindChatById = vi.fn().mockResolvedValue({
  title: "Test Chat",
  type: "supergroup",
  organizationId: null,
});
vi.mock("../../../../src/db/repos/chats.js", () => ({
  findChatById: (...args: unknown[]): unknown => mockFindChatById(...args),
  upsertChat: vi.fn().mockResolvedValue(undefined),
  findActiveChats: vi.fn().mockResolvedValue([]),
  deactivateChat: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../../src/telegram/session.js", () => ({
  getPending: vi.fn().mockReturnValue(undefined),
  clearPending: vi.fn(),
  setPending: vi.fn(),
}));

vi.mock("../../../../src/config.js", () => ({
  loadConfig: () => ({ mailDomain: "tgmail.example.com" }),
}));

const mockCanManageChat = vi.fn().mockResolvedValue(true);
vi.mock("../../../../src/telegram/authorization.js", () => ({
  canManageAlias: vi.fn().mockResolvedValue(true),
  canManageChat: (...args: unknown[]): unknown => mockCanManageChat(...args),
}));

const mockCheckAliasCreateLimit = vi.fn().mockResolvedValue({ ok: true });
const mockHasActiveHostedOrganization = vi.fn().mockResolvedValue(true);
vi.mock("../../../../src/billing/limits.js", () => ({
  checkAliasCreateLimit: (...args: unknown[]): unknown => mockCheckAliasCreateLimit(...args),
  hasActiveHostedOrganization: (...args: unknown[]): unknown =>
    mockHasActiveHostedOrganization(...args),
  withOrganizationQuotaLock: vi.fn(
    async (_db: unknown, _organizationId: string | null, work: (tx: unknown) => Promise<unknown>) =>
      work({}),
  ),
}));

const { newemailHandler } = await import("../../../../src/telegram/commands/newemail.js");

describe("/newemail command", () => {
  const MOCK_ALIAS_ID = "550e8400-e29b-41d4-a716-446655440000";

  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckAliasCreateLimit.mockResolvedValue({ ok: true });
    mockHasActiveHostedOrganization.mockResolvedValue(true);
    mockCanManageChat.mockResolvedValue(true);
    mockFindChatById.mockResolvedValue({
      title: "Test Chat",
      type: "supergroup",
      organizationId: null,
    });
    mockCreateAlias.mockResolvedValue({
      id: MOCK_ALIAS_ID,
      localPart: "alerts-ab12cd",
      fullAddress: "alerts-ab12cd@tgmail.example.com",
    });
  });

  it("creates an alias with the given name and a random suffix", async () => {
    const ctx = createMockCtx({ commandMatch: "alerts" });

    await newemailHandler(ctx);

    expect(mockCreateAlias).toHaveBeenCalledOnce();
    const [, aliasData] = mockCreateAlias.mock.calls[0] as [
      unknown,
      { localPart: string; privacyModeEnabled: boolean; bodyDedupEnabled: boolean },
    ];
    expect(aliasData.localPart).toMatch(/^alerts-[a-z0-9]{6}$/);
    expect(aliasData.privacyModeEnabled).toBe(false);
    expect(aliasData.bodyDedupEnabled).toBe(false);
    expect(ctx.reply).toHaveBeenCalledOnce();
    expect((ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain(
      "tgmail.example.com",
    );
  });

  it("'Add Allow Rule' button uses alias UUID not localPart", async () => {
    const ctx = createMockCtx({ commandMatch: "alerts" });

    await newemailHandler(ctx);

    const replyArgs = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      { reply_markup?: { inline_keyboard?: unknown[][] } },
    ];
    const keyboard = replyArgs[1]?.reply_markup;
    // Button callback_data must be 'am:<UUID>' — not 'am:<localPart>'
    const buttonData = JSON.stringify(keyboard);
    expect(buttonData).toContain(`am:${MOCK_ALIAS_ID}`);
    expect(buttonData).not.toContain("am:alerts");
  });

  it("generates a fully random alias when no name is provided", async () => {
    const ctx = createMockCtx({ commandMatch: "" });

    await newemailHandler(ctx);

    expect(mockCreateAlias).toHaveBeenCalledOnce();
    const [, aliasData] = mockCreateAlias.mock.calls[0] as [unknown, { localPart: string }];
    expect(aliasData.localPart).toMatch(/^[a-z0-9]{8,}$/);
  });

  it("rejects names with uppercase letters", async () => {
    const ctx = createMockCtx({ commandMatch: "MyAlerts" });

    await newemailHandler(ctx);

    expect(mockCreateAlias).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledOnce();
    expect((ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatch(
      /invalid|only.*lowercase|allowed/i,
    );
  });

  it("rejects names with special characters not in [a-z0-9._-]", async () => {
    const ctx = createMockCtx({ commandMatch: "alerts@bad" });

    await newemailHandler(ctx);

    expect(mockCreateAlias).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledOnce();
  });

  it("rejects names longer than 32 characters", async () => {
    const ctx = createMockCtx({ commandMatch: "a".repeat(33) });

    await newemailHandler(ctx);

    expect(mockCreateAlias).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledOnce();
    expect((ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatch(/too long|max/i);
  });

  it("stores the chat_id from context", async () => {
    const ctx = createMockCtx({ commandMatch: "alerts", chatId: -1009999999 });

    await newemailHandler(ctx);

    const [, aliasData] = mockCreateAlias.mock.calls[0] as [unknown, { chatId: bigint }];
    expect(aliasData.chatId).toBe(-1009999999n);
  });

  it("stores organizationId from the target chat when present", async () => {
    mockFindChatById.mockResolvedValueOnce({
      title: "Hosted DM",
      type: "private",
      organizationId: "org-1",
    });
    const ctx = createMockCtx({ commandMatch: "alerts", chatType: "private" });

    await newemailHandler(ctx);

    const [, aliasData] = mockCreateAlias.mock.calls[0] as [
      unknown,
      { organizationId: string | null; domainId: string | null },
    ];
    expect(aliasData.organizationId).toBe("org-1");
    expect(aliasData.domainId).toBeNull();
  });

  it("rejects alias creation when the plan alias limit is reached", async () => {
    mockFindChatById.mockResolvedValueOnce({
      title: "Hosted DM",
      type: "private",
      organizationId: "org-1",
    });
    mockCheckAliasCreateLimit.mockResolvedValueOnce({
      ok: false,
      code: "alias_limit",
      limit: 3,
      used: 3,
    });
    const ctx = createMockCtx({ commandMatch: "alerts", chatType: "private" });

    await newemailHandler(ctx);

    expect(mockCreateAlias).not.toHaveBeenCalled();
    const [text, opts] = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      { reply_markup?: { inline_keyboard: Array<Array<{ callback_data?: string }>> } },
    ];
    expect(text).toMatch(/limit reached|upgrade/i);
    // Should include an upgrade button
    const buttons = opts?.reply_markup?.inline_keyboard?.flat() ?? [];
    expect(buttons.some((b) => b.callback_data === "bill:upgrade")).toBe(true);
  });

  it("shows a hosted workspace error when alias creation has no active organization", async () => {
    mockFindChatById.mockResolvedValueOnce({
      title: "Hosted DM",
      type: "private",
      organizationId: null,
    });
    mockHasActiveHostedOrganization.mockResolvedValueOnce(false);
    const ctx = createMockCtx({ commandMatch: "alerts", chatType: "private" });

    await newemailHandler(ctx);

    expect(mockCreateAlias).not.toHaveBeenCalled();
    expect(mockCanManageChat).not.toHaveBeenCalled();
    expect((ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatch(
      /workspace|not ready|active/i,
    );
  });

  it("stores message_thread_id when present (forum topic)", async () => {
    const ctx = createMockCtx({ commandMatch: "alerts", messageThreadId: 42 });

    await newemailHandler(ctx);

    const [, aliasData] = mockCreateAlias.mock.calls[0] as [
      unknown,
      { messageThreadId: bigint | null },
    ];
    expect(aliasData.messageThreadId).toBe(42n);
  });

  it("stores null messageThreadId when not in a forum topic", async () => {
    const ctx = createMockCtx({ commandMatch: "alerts", messageThreadId: null });

    await newemailHandler(ctx);

    const [, aliasData] = mockCreateAlias.mock.calls[0] as [
      unknown,
      { messageThreadId: bigint | null },
    ];
    expect(aliasData.messageThreadId).toBeNull();
  });

  it("shows friendly error on duplicate alias name", async () => {
    mockCreateAlias.mockRejectedValueOnce(
      new Error("duplicate key value violates unique constraint idx_alias_local_part"),
    );
    const ctx = createMockCtx({ commandMatch: "alerts" });

    await newemailHandler(ctx);

    expect(ctx.reply).toHaveBeenCalledOnce();
    expect((ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatch(/taken|duplicate/i);
  });
});
