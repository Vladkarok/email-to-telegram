import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockCtx } from "../../../helpers/mockContext.js";

vi.mock("../../../../src/db/client.js", () => ({ getDb: vi.fn(() => ({})) }));

const mockCreateAlias = vi.fn();
const mockListAliasesByChat = vi.fn().mockResolvedValue([]);
vi.mock("../../../../src/db/repos/aliases.js", () => ({
  createAlias: (...args: unknown[]): unknown => mockCreateAlias(...args),
  listAliasesByChat: (...args: unknown[]): unknown => mockListAliasesByChat(...args),
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

const mockEnsureSharedInboundDomain = vi.fn();
vi.mock("../../../../src/db/repos/inboundDomains.js", () => ({
  ensureSharedInboundDomain: (...args: unknown[]): unknown =>
    mockEnsureSharedInboundDomain(...args),
}));

const mockSetPending = vi.fn();
vi.mock("../../../../src/telegram/session.js", () => ({
  getPending: vi.fn().mockReturnValue(undefined),
  clearPending: vi.fn(),
  setPending: (...args: unknown[]): unknown => mockSetPending(...args),
}));

const mockLoadConfig = vi.fn(() => ({
  appMode: "self-hosted",
  mailDomain: "tgmail.example.com",
  hostedMailDomain: undefined,
}));
vi.mock("../../../../src/config.js", () => ({
  loadConfig: (): unknown => mockLoadConfig(),
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

const mockReserveHostedAliasCreateAttempt = vi.fn().mockResolvedValue(undefined);
class MockHostedAliasCreateRateLimitError extends Error {}
vi.mock("../../../../src/abuse/hostedAliasCreation.js", () => ({
  HOSTED_ALIAS_CREATE_RATE_LIMIT_MESSAGE:
    "⚠️ Too many alias creation attempts. Please try again later.",
  HostedAliasCreateRateLimitError: MockHostedAliasCreateRateLimitError,
  reserveHostedAliasCreateAttempt: (...args: unknown[]): unknown =>
    mockReserveHostedAliasCreateAttempt(...args),
}));

const { newemailHandler, createEmailAlias } =
  await import("../../../../src/telegram/commands/newemail.js");

describe("/newemail command", () => {
  const MOCK_ALIAS_ID = "550e8400-e29b-41d4-a716-446655440000";

  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckAliasCreateLimit.mockResolvedValue({ ok: true });
    mockHasActiveHostedOrganization.mockResolvedValue(true);
    mockReserveHostedAliasCreateAttempt.mockResolvedValue(undefined);
    mockEnsureSharedInboundDomain.mockResolvedValue({
      id: "shared-domain-1",
      domain: "inbox.example.com",
      kind: "shared",
      status: "active",
    });
    mockLoadConfig.mockReturnValue({
      appMode: "self-hosted",
      mailDomain: "tgmail.example.com",
      hostedMailDomain: undefined,
    });
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

  it("creates an alias with the given name as-is on the first try", async () => {
    mockCreateAlias.mockResolvedValueOnce({
      id: MOCK_ALIAS_ID,
      localPart: "alerts",
      fullAddress: "alerts@tgmail.example.com",
    });
    const ctx = createMockCtx({ commandMatch: "alerts" });

    await newemailHandler(ctx);

    expect(mockCreateAlias).toHaveBeenCalledOnce();
    const [, aliasData] = mockCreateAlias.mock.calls[0] as [
      unknown,
      { localPart: string; privacyModeEnabled: boolean; bodyDedupEnabled: boolean },
    ];
    expect(aliasData.localPart).toBe("alerts");
    expect(aliasData.privacyModeEnabled).toBe(false);
    expect(aliasData.bodyDedupEnabled).toBe(false);
    expect(ctx.reply).toHaveBeenCalledOnce();
    expect((ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain(
      "tgmail.example.com",
    );
  });

  it("retries with a random suffix on duplicate-name collision", async () => {
    mockCreateAlias.mockRejectedValueOnce(
      new Error("duplicate key value violates unique constraint idx_alias_local_part"),
    );
    mockCreateAlias.mockResolvedValueOnce({
      id: MOCK_ALIAS_ID,
      localPart: "alerts-abc123",
      fullAddress: "alerts-abc123@tgmail.example.com",
    });
    const ctx = createMockCtx({ commandMatch: "alerts" });

    await newemailHandler(ctx);

    expect(mockCreateAlias).toHaveBeenCalledTimes(2);
    const [, second] = mockCreateAlias.mock.calls[1] as [unknown, { localPart: string }];
    expect(second.localPart).toMatch(/^alerts-[a-z0-9]{6}$/);
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

  it("starts the naming dialog when no name is provided to the direct command", async () => {
    const ctx = createMockCtx({ commandMatch: "" });

    await newemailHandler(ctx);

    expect(mockCreateAlias).not.toHaveBeenCalled();
    expect(mockSetPending).toHaveBeenCalledWith(123456789, {
      action: "newemail",
      chatId: -1001234567890n,
      chatTitle: "Test Chat",
      messageThreadId: null,
    });
    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringMatching(/creating alias|auto name/i),
      expect.objectContaining({ parse_mode: "HTML" }),
    );
  });

  it("uses 'inbox' as the default friendly name when auto name is selected", async () => {
    mockListAliasesByChat.mockResolvedValueOnce([]);
    mockCreateAlias.mockResolvedValueOnce({
      id: MOCK_ALIAS_ID,
      localPart: "inbox",
      fullAddress: "inbox@tgmail.example.com",
    });
    const ctx = createMockCtx({ commandMatch: "" });

    await createEmailAlias(ctx, "", -1001234567890n, null, "Test Chat");

    expect(mockCreateAlias).toHaveBeenCalledOnce();
    const [, aliasData] = mockCreateAlias.mock.calls[0] as [unknown, { localPart: string }];
    expect(aliasData.localPart).toBe("inbox");
  });

  it("picks the next inbox-N when prior inbox aliases exist", async () => {
    mockListAliasesByChat.mockResolvedValueOnce([
      { localPart: "inbox" },
      { localPart: "inbox-2" },
      { localPart: "inbox-3" },
    ]);
    mockCreateAlias.mockResolvedValueOnce({
      id: MOCK_ALIAS_ID,
      localPart: "inbox-4",
      fullAddress: "inbox-4@tgmail.example.com",
    });
    const ctx = createMockCtx({ commandMatch: "" });

    await createEmailAlias(ctx, "", -1001234567890n, null, "Test Chat");

    const [, aliasData] = mockCreateAlias.mock.calls[0] as [unknown, { localPart: string }];
    expect(aliasData.localPart).toBe("inbox-4");
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
    expect(mockReserveHostedAliasCreateAttempt).toHaveBeenCalledWith(
      expect.anything(),
      "org-1",
      123456789n,
    );
  });

  it("uses the hosted shared inbound domain when hosted mode creates aliases", async () => {
    mockLoadConfig.mockReturnValue({
      appMode: "hosted",
      mailDomain: "legacy.example.com",
      hostedMailDomain: "Inbox.Example.COM",
    });
    mockFindChatById.mockResolvedValueOnce({
      title: "Hosted DM",
      type: "private",
      organizationId: "org-1",
    });
    mockCreateAlias.mockResolvedValueOnce({
      id: MOCK_ALIAS_ID,
      localPart: "alerts-ab12cd",
      fullAddress: "alerts-ab12cd@inbox.example.com",
    });
    const ctx = createMockCtx({ commandMatch: "alerts", chatType: "private" });

    await newemailHandler(ctx);

    expect(mockEnsureSharedInboundDomain).toHaveBeenCalledWith(
      expect.anything(),
      "Inbox.Example.COM",
    );
    const [, aliasData] = mockCreateAlias.mock.calls[0] as [
      unknown,
      { domainId: string | null; fullAddress: string },
    ];
    expect(aliasData.domainId).toBe("shared-domain-1");
    expect(aliasData.fullAddress).toMatch(/@inbox\.example\.com$/);
    expect((ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain("inbox.example.com");
  });

  it("does not create hosted aliases when the shared inbound domain is unavailable", async () => {
    mockLoadConfig.mockReturnValue({
      appMode: "hosted",
      mailDomain: "legacy.example.com",
      hostedMailDomain: "inbox.example.com",
    });
    mockFindChatById.mockResolvedValueOnce({
      title: "Hosted DM",
      type: "private",
      organizationId: "org-1",
    });
    mockEnsureSharedInboundDomain.mockRejectedValueOnce(
      new Error("ensureSharedInboundDomain: hosted shared domain is not active"),
    );
    const ctx = createMockCtx({ commandMatch: "alerts", chatType: "private" });

    await newemailHandler(ctx);

    expect(mockCreateAlias).not.toHaveBeenCalled();
    expect((ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatch(
      /workspace|not ready/i,
    );
  });

  it("rejects alias creation when hosted alias creation is throttled", async () => {
    mockFindChatById.mockResolvedValueOnce({
      title: "Hosted DM",
      type: "private",
      organizationId: "org-1",
    });
    mockReserveHostedAliasCreateAttempt.mockRejectedValueOnce(
      new MockHostedAliasCreateRateLimitError(),
    );
    const ctx = createMockCtx({ commandMatch: "alerts", chatType: "private" });

    await newemailHandler(ctx);

    expect(mockCreateAlias).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("Too many alias"));
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

  it("shows generic fallback for unrecognised limit codes without upgrade button", async () => {
    mockFindChatById.mockResolvedValueOnce({
      title: "Hosted DM",
      type: "private",
      organizationId: "org-1",
    });
    mockCheckAliasCreateLimit.mockResolvedValueOnce({
      ok: false,
      code: "monthly_email_limit",
      limit: 100,
      used: 100,
    });
    const ctx = createMockCtx({ commandMatch: "alerts", chatType: "private" });

    await newemailHandler(ctx);

    expect(mockCreateAlias).not.toHaveBeenCalled();
    const [text, opts] = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      { reply_markup?: { inline_keyboard: Array<Array<{ callback_data?: string }>> } | undefined },
    ];
    expect(text).toMatch(/not available|try again/i);
    // No upgrade button for unrecognised codes
    const buttons = opts?.reply_markup?.inline_keyboard?.flat() ?? [];
    expect(buttons.some((b) => b.callback_data === "bill:upgrade")).toBe(false);
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

  it("shows fallback error after exhausting all suffix attempts", async () => {
    // 5 attempts max — every retry collides
    mockCreateAlias.mockRejectedValue(
      new Error("duplicate key value violates unique constraint idx_alias_local_part"),
    );
    const ctx = createMockCtx({ commandMatch: "alerts" });

    await newemailHandler(ctx);

    expect(mockCreateAlias).toHaveBeenCalledTimes(5);
    expect(ctx.reply).toHaveBeenCalledOnce();
    expect((ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatch(
      /could not pick a unique/i,
    );
  });
});
