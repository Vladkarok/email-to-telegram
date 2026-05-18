import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../../src/db/client.js", () => ({ getDb: vi.fn(() => ({})) }));

const mockLoadConfig = vi.fn(() => ({ appMode: "self-hosted" }));
vi.mock("../../../../src/config.js", () => ({
  loadConfig: (): unknown => mockLoadConfig(),
}));

const mockUpsertChat = vi.fn().mockResolvedValue(undefined);
const mockDeactivateChat = vi.fn().mockResolvedValue(undefined);

vi.mock("../../../../src/db/repos/chats.js", () => ({
  upsertChat: (...args: unknown[]): unknown => mockUpsertChat(...args),
  deactivateChat: (...args: unknown[]): unknown => mockDeactivateChat(...args),
}));

const mockUpsertUser = vi.fn();
vi.mock("../../../../src/db/repos/users.js", () => ({
  upsertUser: (...args: unknown[]): unknown => mockUpsertUser(...args),
  findUserById: vi.fn().mockResolvedValue(null),
}));

const mockEnsurePersonalOrganizationForUserWithOnboardingLimit = vi.fn();
class MockHostedOnboardingRateLimitError extends Error {}
vi.mock("../../../../src/abuse/hostedOnboarding.js", () => ({
  HostedOnboardingRateLimitError: MockHostedOnboardingRateLimitError,
  ensureUserWithOnboardingLimit: (...args: unknown[]): unknown =>
    mockEnsurePersonalOrganizationForUserWithOnboardingLimit(...args),
}));

vi.mock("../../../../src/utils/logger.js", () => ({
  getLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

const { chatMemberHandler } = await import("../../../../src/telegram/handlers/chatMember.js");

function makeCtx(
  chatType: string,
  newStatus: string,
  chatId = -1001234567890,
  title = "Test Group",
  languageCode?: string,
) {
  return {
    myChatMember: {
      new_chat_member: { status: newStatus },
    },
    from: { id: 123456789, username: "adder", language_code: languageCode },
    chat: { id: chatId, type: chatType, title },
  } as unknown as Parameters<typeof chatMemberHandler>[0];
}

describe("chatMemberHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadConfig.mockReturnValue({ appMode: "self-hosted" });
    mockUpsertUser.mockResolvedValue({
      id: 123456789n,
      username: "adder",
      isAllowed: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    mockEnsurePersonalOrganizationForUserWithOnboardingLimit.mockResolvedValue({
      id: "org-1",
      name: "Org",
      planCode: "free",
      subscriptionStatus: "free",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  it("upserts chat when bot is added as member", async () => {
    await chatMemberHandler(makeCtx("supergroup", "member"));
    expect(mockUpsertChat).toHaveBeenCalledOnce();
    const [, data] = mockUpsertChat.mock.calls[0] as [
      unknown,
      { id: bigint; title: string; type: string },
    ];
    expect(data.title).toBe("Test Group");
    expect(data.type).toBe("supergroup");
  });

  it("in hosted mode: onboards the acting user before registering the group chat", async () => {
    mockLoadConfig.mockReturnValue({ appMode: "hosted" });

    await chatMemberHandler(makeCtx("supergroup", "member", undefined, undefined, "uk"));

    expect(mockEnsurePersonalOrganizationForUserWithOnboardingLimit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: 123456789n, username: "adder", locale: "uk" }),
    );
    expect(mockUpsertUser).not.toHaveBeenCalled();
    expect(mockUpsertChat).toHaveBeenCalledOnce();
  });

  it("in hosted mode: still registers the group chat when onboarding is rate limited", async () => {
    // Telegram membership is the source of truth for chat access, so the
    // chat row is created even if the inviting user hit their onboarding
    // rate limit (their own quota work just gets skipped).
    mockLoadConfig.mockReturnValue({ appMode: "hosted" });
    mockEnsurePersonalOrganizationForUserWithOnboardingLimit.mockRejectedValue(
      new MockHostedOnboardingRateLimitError(),
    );

    await chatMemberHandler(makeCtx("supergroup", "member"));

    expect(mockUpsertChat).toHaveBeenCalledOnce();
  });

  it("upserts chat when bot is added as administrator", async () => {
    await chatMemberHandler(makeCtx("group", "administrator"));
    expect(mockUpsertChat).toHaveBeenCalledOnce();
  });

  it("deactivates chat when bot is removed (left)", async () => {
    await chatMemberHandler(makeCtx("supergroup", "left"));
    expect(mockDeactivateChat).toHaveBeenCalledOnce();
    expect(mockUpsertChat).not.toHaveBeenCalled();
  });

  it("deactivates chat when bot is kicked", async () => {
    await chatMemberHandler(makeCtx("supergroup", "kicked"));
    expect(mockDeactivateChat).toHaveBeenCalledOnce();
  });

  it("ignores private chats", async () => {
    await chatMemberHandler(makeCtx("private", "member"));
    expect(mockUpsertChat).not.toHaveBeenCalled();
    expect(mockDeactivateChat).not.toHaveBeenCalled();
  });

  it("does nothing when myChatMember is absent", async () => {
    const ctx = {
      myChatMember: undefined,
      chat: { id: -1, type: "supergroup", title: "X" },
    } as unknown as Parameters<typeof chatMemberHandler>[0];
    await chatMemberHandler(ctx);
    expect(mockUpsertChat).not.toHaveBeenCalled();
  });
});
