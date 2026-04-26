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
}));

const mockEnsurePersonalOrganizationForUser = vi.fn();
vi.mock("../../../../src/tenant/currentOrganization.js", () => ({
  ensurePersonalOrganizationForUser: (...args: unknown[]): unknown =>
    mockEnsurePersonalOrganizationForUser(...args),
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
    mockEnsurePersonalOrganizationForUser.mockResolvedValue({
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

    expect(mockEnsurePersonalOrganizationForUser).toHaveBeenCalledWith(
      expect.anything(),
      BLOCKED_USER,
    );
    expect(next).toHaveBeenCalledOnce();
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it("in hosted mode: registers private DM under the user's organization", async () => {
    mockLoadConfig.mockReturnValue({ appMode: "hosted" });
    mockUpsertUser.mockResolvedValue(BLOCKED_USER);
    const ctx = createMockCtx({ chatType: "private", fromId: 999 });

    await authMiddleware(ctx, next);

    expect(mockUpsertChat).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        id: 999n,
        organizationId: "org-1",
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

  it("upserts user with correct id and username", async () => {
    mockUpsertUser.mockResolvedValue(ALLOWED_USER);
    const ctx = createMockCtx({ fromId: 123456789, username: "myuser" });

    await authMiddleware(ctx, next);

    expect(mockUpsertUser).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: 123456789n, username: "myuser" }),
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
