import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockCtx } from "../../../helpers/mockContext.js";

vi.mock("../../../../src/db/client.js", () => ({ getDb: vi.fn(() => ({})) }));

const mockUpsertUser = vi.fn();
vi.mock("../../../../src/db/repos/users.js", () => ({
  upsertUser: (...args: unknown[]): unknown => mockUpsertUser(...args),
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
