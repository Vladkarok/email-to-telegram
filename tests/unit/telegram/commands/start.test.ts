import { describe, it, expect, vi } from "vitest";
import { helpHandler } from "../../../../src/telegram/commands/help.js";
import { createMockCtx } from "../../../helpers/mockContext.js";

vi.mock("../../../../src/db/client.js", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("../../../../src/db/repos/chats.js", () => ({
  upsertChat: vi.fn().mockResolvedValue(undefined),
  findActiveChats: vi.fn().mockResolvedValue([]),
}));

const { startHandler } = await import("../../../../src/telegram/commands/start.js");

describe("/start command", () => {
  it("in private chat: registers DM and shows chat selection", async () => {
    const ctx = createMockCtx({ chatType: "private" });
    await startHandler(ctx);
    expect(ctx.reply).toHaveBeenCalled();
    const firstCall = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as unknown;
    expect(String(firstCall)).toMatch(/Welcome|manage/i);
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
    expect(String(text)).toContain("one-time web view link");
  });

  it("includes the operational-use disclaimer", async () => {
    const ctx = createMockCtx();
    await helpHandler(ctx);
    const text = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as unknown;
    expect(String(text)).toContain("not for secrets or regulated/confidential data");
    expect(String(text)).toContain("Do not rely on Telegram forwarding as your only life-safety");
  });
});
