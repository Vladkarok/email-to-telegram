import { beforeEach, describe, it, expect, vi } from "vitest";
import { createMockCtx } from "../../../helpers/mockContext.js";

vi.mock("../../../../src/db/client.js", () => ({ getDb: vi.fn(() => ({})) }));

const mockLoadConfig = vi.fn(() => ({ appMode: "hosted" }));
vi.mock("../../../../src/config.js", () => ({
  loadConfig: (): unknown => mockLoadConfig(),
}));

const mockFindUserById = vi.fn();
vi.mock("../../../../src/db/repos/users.js", () => ({
  findUserById: (...args: unknown[]): unknown => mockFindUserById(...args),
}));

const { planHandler } = await import("../../../../src/telegram/commands/plan.js");

describe("/plan command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadConfig.mockReturnValue({ appMode: "hosted" });
  });

  it("in self-hosted mode replies with billing-disabled message", async () => {
    mockLoadConfig.mockReturnValue({ appMode: "self-hosted" });
    const ctx = createMockCtx({ chatType: "private" });

    await planHandler(ctx);

    const [text] = ctx.reply.mock.calls[0] as [string, unknown];
    expect(text).toMatch(/self-hosted|billing.*not enabled/i);
  });

  it("in hosted mode with no organization replies defensively", async () => {
    mockFindUserById.mockResolvedValue(null);
    const ctx = createMockCtx({ chatType: "private" });

    await planHandler(ctx);

    const [text] = ctx.reply.mock.calls[0] as [string, unknown];
    expect(text).toMatch(/no.*workspace|organization.*not found/i);
  });

  it("renders the free plan for a free organization", async () => {
    mockFindUserById.mockResolvedValue({
      id: "org-1",
      name: "Test Org",
      planCode: "free",
      subscriptionStatus: "free",
      currentPeriodEnd: null,
    });
    const ctx = createMockCtx({ chatType: "private" });

    await planHandler(ctx);

    const [text] = ctx.reply.mock.calls[0] as [string, unknown];
    expect(String(text)).toContain("Free");
    expect(String(text)).toMatch(/3/); // alias limit
  });

  it("renders the pro plan for an active pro subscription", async () => {
    mockFindUserById.mockResolvedValue({
      id: "org-1",
      name: "Test Org",
      planCode: "pro",
      subscriptionStatus: "active",
      currentPeriodEnd: new Date("2030-01-01T00:00:00Z"),
    });
    const ctx = createMockCtx({ chatType: "private" });

    await planHandler(ctx);

    const [text] = ctx.reply.mock.calls[0] as [string, unknown];
    expect(String(text)).toContain("Pro");
    expect(String(text)).toMatch(/active/i);
  });

  it("renders the free effective plan for a canceled subscription", async () => {
    mockFindUserById.mockResolvedValue({
      id: "org-1",
      name: "Test Org",
      planCode: "pro",
      subscriptionStatus: "canceled",
      currentPeriodEnd: null,
    });
    const ctx = createMockCtx({ chatType: "private" });

    await planHandler(ctx);

    const [text] = ctx.reply.mock.calls[0] as [string, unknown];
    // Should expose effective plan = Free, not Pro, plus mention the canceled state.
    expect(String(text)).toMatch(/Free/);
    expect(String(text)).toMatch(/canceled/i);
  });

  it("uses HTML parse mode", async () => {
    mockFindUserById.mockResolvedValue({
      id: "org-1",
      name: "Test Org",
      planCode: "free",
      subscriptionStatus: "free",
      currentPeriodEnd: null,
    });
    const ctx = createMockCtx({ chatType: "private" });

    await planHandler(ctx);

    const [, opts] = ctx.reply.mock.calls[0] as [string, { parse_mode?: string }];
    expect(opts.parse_mode).toBe("HTML");
  });
});
