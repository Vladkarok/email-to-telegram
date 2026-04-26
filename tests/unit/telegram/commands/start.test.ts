import { beforeEach, describe, it, expect, vi } from "vitest";
import { helpHandler } from "../../../../src/telegram/commands/help.js";
import { createMockCtx } from "../../../helpers/mockContext.js";

vi.mock("../../../../src/db/client.js", () => ({ getDb: vi.fn(() => ({})) }));

const mockLoadConfig = vi.fn(() => ({ appMode: "self-hosted" }));
vi.mock("../../../../src/config.js", () => ({
  loadConfig: (): unknown => mockLoadConfig(),
}));

const mockUpsertChat = vi.fn().mockResolvedValue(undefined);
vi.mock("../../../../src/db/repos/chats.js", () => ({
  upsertChat: (...args: unknown[]): unknown => mockUpsertChat(...args),
  findActiveChats: vi.fn().mockResolvedValue([]),
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

const { startHandler } = await import("../../../../src/telegram/commands/start.js");

describe("/start command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadConfig.mockReturnValue({ appMode: "self-hosted" });
    mockUpsertUser.mockResolvedValue({
      id: 123456789n,
      username: "testuser",
      isAllowed: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    mockEnsurePersonalOrganizationForUser.mockResolvedValue({
      id: "org-1",
      name: "Org",
      planCode: "free",
      subscriptionStatus: "free",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  it("in private chat: registers DM and shows chat selection", async () => {
    const ctx = createMockCtx({ chatType: "private" });
    await startHandler(ctx);
    expect(mockUpsertChat).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ organizationId: null }),
    );
    expect(ctx.reply).toHaveBeenCalled();
    const firstCall = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as unknown;
    expect(String(firstCall)).toMatch(/Welcome|manage/i);
  });

  it("in hosted mode: onboards user and registers DM chat under the organization", async () => {
    mockLoadConfig.mockReturnValue({ appMode: "hosted" });
    const ctx = createMockCtx({ chatType: "private", fromId: 123456789 });

    await startHandler(ctx);

    expect(mockUpsertUser).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: 123456789n }),
    );
    expect(mockEnsurePersonalOrganizationForUser).toHaveBeenCalled();
    expect(mockUpsertChat).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ organizationId: "org-1" }),
    );
  });

  it("in group chat: redirects to DM with button", async () => {
    const ctx = createMockCtx({ chatType: "supergroup" });
    await startHandler(ctx);
    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining("private chat"),
      expect.objectContaining({ reply_markup: expect.anything() as unknown }),
    );
  });
});

describe("/help command", () => {
  it("replies with /start as primary entry point", async () => {
    const ctx = createMockCtx();
    await helpHandler(ctx);
    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining("/start"),
      expect.objectContaining({ parse_mode: "HTML" }),
    );
  });

  it("mentions allow rules", async () => {
    const ctx = createMockCtx();
    await helpHandler(ctx);
    const text = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as unknown;
    expect(String(text)).toContain("/allow");
  });

  it("explains how to test html and markdown render modes", async () => {
    const ctx = createMockCtx();
    await helpHandler(ctx);
    const text = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as unknown;
    expect(String(text)).toContain("use Gmail or mail-client formatting buttons");
    expect(String(text)).toContain("type markdown syntax literally");
    expect(String(text)).toContain("browser view link");
  });

  it("includes the operational-use disclaimer", async () => {
    const ctx = createMockCtx();
    await helpHandler(ctx);
    const text = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as unknown;
    expect(String(text)).toContain("not for secrets or regulated/confidential data");
    expect(String(text)).toContain("Do not rely on Telegram forwarding as your only life-safety");
  });
});
