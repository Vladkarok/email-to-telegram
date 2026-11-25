/**
 * The /newemail command around alias creation: authorization, the naming
 * dialog, the input handed to createAliasForChat, and the reply for each
 * creation outcome. The creation rules themselves run on Postgres in
 * tests/db/aliasOperations.pg.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockCtx } from "../../../helpers/mockContext.js";
import { getMessages } from "../../../../src/i18n/index.js";
import type { AliasCreationResult } from "../../../../src/aliases/creation.js";
import type { EmailAddress } from "../../../../src/db/schema.js";

vi.mock("../../../../src/db/client.js", () => ({ getDb: vi.fn(() => ({})) }));

const mockFindChatById = vi.fn().mockResolvedValue({ title: "Test Chat", type: "supergroup" });
vi.mock("../../../../src/db/repos/chats.js", () => ({
  findChatById: (...args: unknown[]): unknown => mockFindChatById(...args),
}));

const mockSetPending = vi.fn();
const mockClearPending = vi.fn();
vi.mock("../../../../src/telegram/session.js", () => ({
  getPending: vi.fn().mockReturnValue(undefined),
  clearPending: (...args: unknown[]): unknown => mockClearPending(...args),
  setPending: (...args: unknown[]): unknown => mockSetPending(...args),
}));

const CONFIG = { appMode: "self-hosted", mailDomain: "tgmail.example.com" };
vi.mock("../../../../src/config.js", () => ({ loadConfig: (): unknown => CONFIG }));

const mockCanManageChat = vi.fn().mockResolvedValue(true);
vi.mock("../../../../src/telegram/authorization.js", () => ({
  canManageChat: (...args: unknown[]): unknown => mockCanManageChat(...args),
}));

const mockHasActiveHostedUser = vi.fn().mockResolvedValue(true);
vi.mock("../../../../src/billing/limits.js", () => ({
  hasActiveHostedUser: (...args: unknown[]): unknown => mockHasActiveHostedUser(...args),
}));

const mockCreateAliasForChat = vi.fn();
vi.mock("../../../../src/aliases/creation.js", () => ({
  createAliasForChat: (...args: unknown[]): unknown => mockCreateAliasForChat(...args),
}));

const { newemailHandler, createEmailAlias, replyForAliasCreation } =
  await import("../../../../src/telegram/commands/newemail.js");

const en = getMessages("en");
const ALIAS_ID = "550e8400-e29b-41d4-a716-446655440000";
const CREATED: AliasCreationResult = {
  kind: "created",
  alias: { id: ALIAS_ID, fullAddress: "alerts@tgmail.example.com" } as EmailAddress,
};

type ReplyCall = [
  string,
  { reply_markup?: { inline_keyboard: Array<Array<Record<string, string>>> } }?,
];

function replies(ctx: ReturnType<typeof createMockCtx>): ReplyCall[] {
  return ctx.reply.mock.calls as ReplyCall[];
}

beforeEach(() => {
  vi.clearAllMocks();
  mockHasActiveHostedUser.mockResolvedValue(true);
  mockCanManageChat.mockResolvedValue(true);
  mockFindChatById.mockResolvedValue({ title: "Test Chat", type: "supergroup" });
  mockCreateAliasForChat.mockResolvedValue(CREATED);
});

describe("/newemail command", () => {
  it("starts the naming dialog when no name is provided", async () => {
    const ctx = createMockCtx({ commandMatch: "" });

    await newemailHandler(ctx);

    expect(mockCreateAliasForChat).not.toHaveBeenCalled();
    expect(mockSetPending).toHaveBeenCalledWith(123456789, {
      action: "newemail",
      chatId: -1001234567890n,
      chatTitle: "Test Chat",
      messageThreadId: null,
    });
    expect(ctx.reply).toHaveBeenCalledWith(
      en.newemail.prompt("Test Chat"),
      expect.objectContaining({ parse_mode: "HTML" }),
    );
  });

  it("shows the hosted account error before the chat check", async () => {
    mockHasActiveHostedUser.mockResolvedValueOnce(false);
    const ctx = createMockCtx({ commandMatch: "alerts" });

    await newemailHandler(ctx);

    expect(mockCanManageChat).not.toHaveBeenCalled();
    expect(mockCreateAliasForChat).not.toHaveBeenCalled();
    expect(mockClearPending).toHaveBeenCalledWith(123456789);
    expect(replies(ctx)[0]?.[0]).toBe(en.common.hostedAccountInactive);
  });

  it("denies a user who cannot manage the chat, checking freshly", async () => {
    mockCanManageChat.mockResolvedValueOnce(false);
    const ctx = createMockCtx({ commandMatch: "alerts" });

    await newemailHandler(ctx);

    expect(mockCanManageChat).toHaveBeenCalledWith(expect.anything(), 123456789, -1001234567890n, {
      fresh: true,
    });
    expect(mockCreateAliasForChat).not.toHaveBeenCalled();
    expect(replies(ctx)[0]?.[0]).toBe(en.common.accessDenied);
  });

  it("creates in the current chat and topic as the acting user", async () => {
    const ctx = createMockCtx({ commandMatch: "alerts", chatId: -1009999999, messageThreadId: 42 });

    await newemailHandler(ctx);

    expect(mockCreateAliasForChat).toHaveBeenCalledWith(
      expect.anything(),
      { createdBy: 123456789n, chatId: -1009999999n, threadId: 42n, requestedName: "alerts" },
      CONFIG,
    );
    const [[text, opts]] = replies(ctx);
    expect(text).toBe(
      en.newemail.created("alerts@tgmail.example.com", en.newemail.deliveringTo("Test Chat")),
    );
    expect(opts?.reply_markup?.inline_keyboard.flat().map((b) => b.callback_data)).toContain(
      `am:${ALIAS_ID}`,
    );
  });

  it("replies to a refused creation in the user's language", async () => {
    mockCreateAliasForChat.mockResolvedValueOnce({ kind: "name_taken" });
    const ctx = createMockCtx({ commandMatch: "alerts", languageCode: "uk" });

    await newemailHandler(ctx);

    expect(replies(ctx)).toEqual([[getMessages("uk").newemail.nameTaken]]);
  });

  it("asks for an automatic name when the name is empty", async () => {
    const ctx = createMockCtx();

    await createEmailAlias(ctx, "", 123n, null, "Test Chat");

    expect(mockCreateAliasForChat).toHaveBeenCalledWith(
      expect.anything(),
      { createdBy: 123456789n, chatId: 123n, threadId: null, requestedName: null },
      CONFIG,
    );
  });
});

describe("creation result replies", () => {
  async function replyFor(result: AliasCreationResult): Promise<ReplyCall[]> {
    const ctx = createMockCtx();
    await replyForAliasCreation(ctx, result, "Test Chat", "en");
    return replies(ctx);
  }

  it.each([
    ["name_too_long", en.newemail.nameTooLong],
    ["invalid_name", en.newemail.invalidName],
    ["name_cooldown", en.newemail.nameCooldown],
    ["chat_migrated", en.newemail.chatUnavailable],
    ["domain_unavailable", en.newemail.sharedDomainUnavailable],
    ["name_taken", en.newemail.nameTaken],
    ["no_unique_name", en.newemail.uniqueNameFailed],
  ] as const)("%s replies with its message", async (kind, text) => {
    expect(await replyFor({ kind })).toEqual([[text]]);
  });

  it("impersonation replies with the guard's message", async () => {
    expect(await replyFor({ kind: "impersonation" })).toEqual([
      [
        "⛔ This alias name impersonates a reserved mailbox or a well-known brand. Please pick something else.",
      ],
    ]);
  });

  it("rate_limited replies with the throttle message", async () => {
    expect(await replyFor({ kind: "rate_limited" })).toEqual([
      ["⚠️ Too many alias creation attempts. Please try again later."],
    ]);
  });

  it("the alias limit offers an upgrade", async () => {
    const [[text, opts]] = await replyFor({
      kind: "limit",
      limit: { ok: false, code: "alias_limit", limit: 3, used: 3 },
    });

    expect(text).toBe(en.newemail.aliasLimitReached(3, 3));
    expect(opts?.reply_markup?.inline_keyboard).toEqual([
      [{ text: en.newemail.upgradePlanButton, callback_data: "bill:upgrade" }],
    ]);
  });

  it("a missing hosted user is the hosted account error", async () => {
    expect(
      await replyFor({ kind: "limit", limit: { ok: false, code: "subscription_inactive" } }),
    ).toEqual([[en.common.hostedAccountInactive]]);
  });

  it("any other limit code is the generic unavailable reply", async () => {
    expect(
      await replyFor({ kind: "limit", limit: { ok: false, code: "monthly_email_limit" } }),
    ).toEqual([[en.common.aliasCreationUnavailable]]);
  });

  it("created shows the address, the chat and the quick allow-rule picks", async () => {
    const [[text, opts]] = await replyFor(CREATED);

    expect(text).toBe(
      en.newemail.created("alerts@tgmail.example.com", en.newemail.deliveringTo("Test Chat")),
    );
    expect(text).toContain("Allow google.com first");
    const keyboard = opts?.reply_markup?.inline_keyboard ?? [];
    expect(keyboard[0]?.map((b) => b.text)).toEqual([
      "🔐 google.com",
      "🔐 github.com",
      "🔐 gmail.com",
    ]);
    // The manage button carries the alias UUID, never the local part.
    expect(keyboard.flat().map((b) => b.callback_data)).toContain(`am:${ALIAS_ID}`);
  });

  it("created without a chat title has no delivery note", async () => {
    const ctx = createMockCtx();
    await replyForAliasCreation(ctx, CREATED, undefined, "en");

    expect(replies(ctx)[0]?.[0]).toBe(en.newemail.created("alerts@tgmail.example.com", ""));
  });
});
