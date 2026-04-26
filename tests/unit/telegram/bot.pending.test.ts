import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Context } from "grammy";
import { createMockCtx } from "../../helpers/mockContext.js";

vi.mock("../../../src/db/client.js", () => ({ getDb: vi.fn(() => ({})) }));

const mockGetPending = vi.fn();
const mockClearPending = vi.fn();
vi.mock("../../../src/telegram/session.js", () => ({
  getPending: (...args: unknown[]): unknown => mockGetPending(...args),
  clearPending: (...args: unknown[]): unknown => mockClearPending(...args),
  setPending: vi.fn(),
}));

const mockCanManageAlias = vi.fn().mockResolvedValue(true);
const mockCanManageChat = vi.fn().mockResolvedValue(true);
vi.mock("../../../src/telegram/authorization.js", () => ({
  canManageAlias: (...args: unknown[]): unknown => mockCanManageAlias(...args),
  canManageChat: (...args: unknown[]): unknown => mockCanManageChat(...args),
}));

const mockHasActiveHostedOrganization = vi.fn().mockResolvedValue(true);
vi.mock("../../../src/billing/limits.js", () => ({
  hasActiveHostedOrganization: (...args: unknown[]): unknown =>
    mockHasActiveHostedOrganization(...args),
}));

const mockFindAliasById = vi.fn();
const mockFindChatById = vi.fn();
vi.mock("../../../src/db/repos/aliases.js", () => ({
  findAliasById: (...args: unknown[]): unknown => mockFindAliasById(...args),
  updateAliasBodyDedup: vi.fn(),
  updateAliasPrivacyMode: vi.fn(),
  updateAliasStatus: vi.fn(),
  updateAliasRenderMode: vi.fn(),
}));

const mockAddAllowRuleForAlias = vi.fn();
vi.mock("../../../src/telegram/commands/allow.js", () => ({
  allowHandler: vi.fn(),
  addAllowRuleForAlias: (...args: unknown[]): unknown => mockAddAllowRuleForAlias(...args),
}));

const mockSendAllowRulesMenu = vi.fn();
vi.mock("../../../src/telegram/menu/allowRulesMenu.js", () => ({
  sendAllowRulesMenu: (...args: unknown[]): unknown => mockSendAllowRulesMenu(...args),
  editAllowRulesMenu: vi.fn(),
}));

vi.mock("../../../src/telegram/commands/start.js", () => ({ startHandler: vi.fn() }));
const mockCreateEmailAlias = vi.fn();
vi.mock("../../../src/telegram/commands/newemail.js", () => ({
  newemailHandler: vi.fn(),
  createEmailAlias: (...args: unknown[]): unknown => mockCreateEmailAlias(...args),
}));
vi.mock("../../../src/telegram/commands/listemail.js", () => ({ listemailHandler: vi.fn() }));
vi.mock("../../../src/telegram/commands/deleteemail.js", () => ({ deleteemailHandler: vi.fn() }));
vi.mock("../../../src/telegram/commands/pauseemail.js", () => ({ pauseemailHandler: vi.fn() }));
vi.mock("../../../src/telegram/commands/resumeemail.js", () => ({ resumeemailHandler: vi.fn() }));
vi.mock("../../../src/telegram/commands/settings.js", () => ({
  settingsHandler: vi.fn(),
  buildAliasSettingsKeyboard: vi.fn(),
  buildAliasSettingsText: vi.fn(),
}));
vi.mock("../../../src/telegram/commands/help.js", () => ({ helpHandler: vi.fn() }));
vi.mock("../../../src/telegram/handlers/chatMember.js", () => ({ chatMemberHandler: vi.fn() }));
vi.mock("../../../src/telegram/menu/chatMenu.js", () => ({
  editChatSelectionMenu: vi.fn(),
  editChatManagementMenu: vi.fn(),
}));
vi.mock("../../../src/telegram/menu/aliasMenu.js", () => ({
  editAliasListMenu: vi.fn(),
  editAliasDetailMenu: vi.fn(),
}));
vi.mock("../../../src/db/repos/chats.js", () => ({
  findChatById: (...args: unknown[]): unknown => mockFindChatById(...args),
}));
vi.mock("../../../src/db/repos/allowRules.js", () => ({
  findAllowRuleById: vi.fn(),
  removeAllowRule: vi.fn(),
}));
vi.mock("../../../src/utils/logger.js", () => ({
  getLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));
const mockAuthMiddleware = vi.fn(async (_ctx: unknown, next: () => Promise<void>) => next());
vi.mock("../../../src/telegram/middleware/auth.js", () => ({
  authMiddleware: (...args: unknown[]): unknown => mockAuthMiddleware(...args),
}));

const {
  createBot,
  handlePendingTextMessage,
  assertHostedAliasWorkspaceReady,
  assertHostedChatWorkspaceReady,
} = await import("../../../src/telegram/bot.js");

const mockAnswerCallbackQuery = vi
  .spyOn(Context.prototype, "answerCallbackQuery")
  .mockResolvedValue(true as never);

function buildCallbackUpdate(data: string) {
  return {
    update_id: 1,
    callback_query: {
      id: "cb-1",
      from: {
        id: 123,
        is_bot: false,
        first_name: "Test",
      },
      chat_instance: "ci-1",
      data,
      message: {
        message_id: 1,
        date: 0,
        chat: {
          id: 123,
          type: "private",
        },
      },
    },
  };
}

function createInitializedBot() {
  const bot = createBot("test-token");
  bot.botInfo = {
    id: 999,
    is_bot: true,
    first_name: "Test Bot",
    username: "test_bot",
    can_join_groups: true,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
  };
  return bot;
}

describe("pending text flow", () => {
  const next = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    mockHasActiveHostedOrganization.mockResolvedValue(true);
    mockCanManageChat.mockResolvedValue(true);
    mockCanManageAlias.mockResolvedValue(true);
    mockFindChatById.mockResolvedValue({
      id: -1001234567890n,
      title: "Alerts",
      organizationId: "org-1",
    });
    mockGetPending.mockReturnValue({
      action: "allowrule",
      aliasId: "alias-1",
      aliasLocalPart: "alerts",
    });
    mockFindAliasById.mockResolvedValue({
      id: "alias-1",
      localPart: "alerts",
      organizationId: "org-1",
    });
    mockAddAllowRuleForAlias.mockResolvedValue(true);
    mockCreateEmailAlias.mockResolvedValue(undefined);
  });

  afterAll(() => {
    mockAnswerCallbackQuery.mockRestore();
  });

  it("creates a pending alias when the hosted workspace is active", async () => {
    mockGetPending.mockReturnValue({
      action: "newemail",
      chatId: -1001234567890n,
      chatTitle: "Alerts",
    });
    const ctx = createMockCtx({ text: "alerts" });

    await handlePendingTextMessage(ctx, next);

    expect(mockCanManageChat).toHaveBeenCalled();
    expect(mockCreateEmailAlias).toHaveBeenCalledWith(
      ctx,
      "alerts",
      -1001234567890n,
      null,
      "Alerts",
    );
  });

  it("shows the hosted workspace message before chat auth when pending alias creation has no active org", async () => {
    mockGetPending.mockReturnValue({
      action: "newemail",
      chatId: -1001234567890n,
      chatTitle: "Alerts",
    });
    mockHasActiveHostedOrganization.mockResolvedValueOnce(false);
    const ctx = createMockCtx({ text: "alerts" });

    await handlePendingTextMessage(ctx, next);

    expect(mockCanManageChat).not.toHaveBeenCalled();
    expect(mockCreateEmailAlias).not.toHaveBeenCalled();
    expect((ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatch(
      /workspace|not ready|active/i,
    );
  });

  it("blocks the callback newemail entrypoint when the hosted workspace is inactive", async () => {
    mockHasActiveHostedOrganization.mockResolvedValueOnce(false);
    const ctx = {
      answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    };

    await expect(assertHostedChatWorkspaceReady(ctx as never, -1001234567890n)).resolves.toBe(
      false,
    );

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
      expect.stringMatching(/hosted workspace inactive/i),
    );
  });

  it("wires the cn callback through the hosted workspace guard before chat auth", async () => {
    mockHasActiveHostedOrganization.mockResolvedValueOnce(false);
    const bot = createInitializedBot();

    await bot.handleUpdate(buildCallbackUpdate("cn:-1001234567890") as never);

    expect(mockCanManageChat).not.toHaveBeenCalled();
    expect(mockAnswerCallbackQuery).toHaveBeenCalledWith(
      expect.stringMatching(/hosted workspace inactive/i),
    );
  });

  it("wires the ns callback through the hosted workspace guard before chat auth", async () => {
    mockHasActiveHostedOrganization.mockResolvedValueOnce(false);
    const bot = createInitializedBot();

    await bot.handleUpdate(buildCallbackUpdate("ns:-1001234567890") as never);

    expect(mockCanManageChat).not.toHaveBeenCalled();
    expect(mockAnswerCallbackQuery).toHaveBeenCalledWith(
      expect.stringMatching(/hosted workspace inactive/i),
    );
  });

  it("sends the allow-rules menu on successful pending allow-rule creation", async () => {
    const ctx = createMockCtx({ text: "github.com" });

    await handlePendingTextMessage(ctx, next);

    expect(mockAddAllowRuleForAlias).toHaveBeenCalled();
    expect(mockSendAllowRulesMenu).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "alias-1",
    );
  });

  it("does not reopen the menu when quota/inactive-org helper rejects the rule", async () => {
    mockAddAllowRuleForAlias.mockImplementation(
      async (ctx: { reply: (text: string) => Promise<void> }) => {
        await ctx.reply("⛔ alias is not attached to an active hosted workspace.");
        return false;
      },
    );
    const ctx = createMockCtx({ text: "github.com" });

    await handlePendingTextMessage(ctx, next);

    expect(mockSendAllowRulesMenu).not.toHaveBeenCalled();
    expect((ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatch(
      /active hosted workspace/i,
    );
  });

  it("shows the hosted workspace message before alias auth when the alias org is inactive", async () => {
    mockHasActiveHostedOrganization.mockResolvedValueOnce(false);
    const ctx = createMockCtx({ text: "github.com" });

    await handlePendingTextMessage(ctx, next);

    expect(mockCanManageAlias).not.toHaveBeenCalled();
    expect(mockAddAllowRuleForAlias).not.toHaveBeenCalled();
    expect((ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatch(
      /active hosted workspace/i,
    );
  });

  it("blocks the callback allow-rule entrypoint when the hosted workspace is inactive", async () => {
    mockHasActiveHostedOrganization.mockResolvedValueOnce(false);
    const ctx = {
      answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    };

    await expect(assertHostedAliasWorkspaceReady(ctx as never, "alias-1")).resolves.toBe(false);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
      expect.stringMatching(/hosted workspace inactive/i),
    );
  });

  it("wires the aa callback through the hosted workspace guard before alias auth", async () => {
    mockHasActiveHostedOrganization.mockResolvedValueOnce(false);
    const bot = createInitializedBot();

    await bot.handleUpdate(buildCallbackUpdate("aa:550e8400-e29b-41d4-a716-446655440000") as never);

    expect(mockCanManageAlias).not.toHaveBeenCalled();
    expect(mockAnswerCallbackQuery).toHaveBeenCalledWith(
      expect.stringMatching(/hosted workspace inactive/i),
    );
  });
});
