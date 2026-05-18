import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockCtx } from "../../../helpers/mockContext.js";

vi.mock("../../../../src/db/client.js", () => ({ getDb: vi.fn(() => ({})) }));

const mockLoadConfig = vi.fn(() => ({ appMode: "self-hosted" }));
vi.mock("../../../../src/config.js", () => ({
  loadConfig: (): unknown => mockLoadConfig(),
}));

const mockUpsertChat = vi.fn();
vi.mock("../../../../src/db/repos/chats.js", () => ({
  upsertChat: (...args: unknown[]): unknown => mockUpsertChat(...args),
}));

const mockUpsertUser = vi.fn();
vi.mock("../../../../src/db/repos/users.js", () => ({
  upsertUser: (...args: unknown[]): unknown => mockUpsertUser(...args),
  findUserById: vi.fn().mockResolvedValue(null),
}));

const mockEnsurePersonalOrganizationForUserWithOnboardingLimit = vi.fn();
class MockHostedOnboardingRateLimitError extends Error {}
vi.mock("../../../../src/abuse/hostedOnboarding.js", () => ({
  HOSTED_ONBOARDING_RATE_LIMIT_MESSAGE:
    "⚠️ Too many workspace setup attempts. Please try again later.",
  HostedOnboardingRateLimitError: MockHostedOnboardingRateLimitError,
  ensureUserWithOnboardingLimit: (...args: unknown[]): unknown =>
    mockEnsurePersonalOrganizationForUserWithOnboardingLimit(...args),
}));

// Import after mocking
const { authMiddleware } = await import("../../../../src/telegram/middleware/auth.js");

const ALLOWED_USER = {
  id: 123456789n,
  username: "testuser",
  isAllowed: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const BLOCKED_USER = { ...ALLOWED_USER, isAllowed: false };

describe("authMiddleware", () => {
  const next = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadConfig.mockReturnValue({ appMode: "self-hosted" });
    mockUpsertChat.mockResolvedValue(undefined);
    mockEnsurePersonalOrganizationForUserWithOnboardingLimit.mockResolvedValue({
      id: "org-1",
      name: "Org",
      planCode: "free",
      subscriptionStatus: "free",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  it("calls next() when user is allowed", async () => {
    mockUpsertUser.mockResolvedValue(ALLOWED_USER);
    const ctx = createMockCtx({ fromId: 123456789 });

    await authMiddleware(ctx, next);

    expect(next).toHaveBeenCalledOnce();
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it("replies with access denied and does not call next() when user is not allowed", async () => {
    mockUpsertUser.mockResolvedValue(BLOCKED_USER);
    const ctx = createMockCtx({ fromId: 999 });

    await authMiddleware(ctx, next);

    expect(next).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledOnce();
    expect((ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatch(
      /access denied|not authorized|not allowed/i,
    );
  });

  it("auto-onboards hosted users and does not require isAllowed", async () => {
    mockLoadConfig.mockReturnValue({ appMode: "hosted" });
    mockUpsertUser.mockResolvedValue(BLOCKED_USER);
    const ctx = createMockCtx({ fromId: 999 });

    await authMiddleware(ctx, next);

    expect(mockEnsurePersonalOrganizationForUserWithOnboardingLimit).toHaveBeenCalledWith(
      expect.anything(),
      BLOCKED_USER,
    );
    expect(next).toHaveBeenCalledOnce();
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it("in hosted mode: registers private DM after upserting the user", async () => {
    mockLoadConfig.mockReturnValue({ appMode: "hosted" });
    mockUpsertUser.mockResolvedValue(BLOCKED_USER);
    const ctx = createMockCtx({ chatType: "private", fromId: 999 });

    await authMiddleware(ctx, next);

    expect(mockUpsertChat).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        id: 999n,
        type: "private",
      }),
    );
    expect(next).toHaveBeenCalledOnce();
  });

  it("in hosted mode: does not register group chats from auth middleware", async () => {
    mockLoadConfig.mockReturnValue({ appMode: "hosted" });
    mockUpsertUser.mockResolvedValue(BLOCKED_USER);
    const ctx = createMockCtx({ chatType: "supergroup", fromId: 999 });

    await authMiddleware(ctx, next);

    expect(mockUpsertChat).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });

  it("in hosted mode: stops when onboarding is rate limited", async () => {
    mockLoadConfig.mockReturnValue({ appMode: "hosted" });
    mockUpsertUser.mockResolvedValue(BLOCKED_USER);
    mockEnsurePersonalOrganizationForUserWithOnboardingLimit.mockRejectedValue(
      new MockHostedOnboardingRateLimitError(),
    );
    const ctx = createMockCtx({ chatType: "private", fromId: 999 });

    await authMiddleware(ctx, next);

    expect(next).not.toHaveBeenCalled();
    expect(mockUpsertChat).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("Too many workspace"));
  });

  it("upserts user with correct id and username", async () => {
    mockUpsertUser.mockResolvedValue(ALLOWED_USER);
    const ctx = createMockCtx({ fromId: 123456789, username: "myuser", languageCode: "uk-UA" });

    await authMiddleware(ctx, next);

    expect(mockUpsertUser).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: 123456789n, username: "myuser", locale: "uk" }),
    );
  });

  it("silently ignores messages without a from field", async () => {
    const ctx = createMockCtx();
    // @ts-expect-error — testing missing from
    ctx.from = undefined;

    await authMiddleware(ctx, next);

    expect(next).not.toHaveBeenCalled();
    expect(mockUpsertUser).not.toHaveBeenCalled();
  });
});
