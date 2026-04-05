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
    (ctx as unknown as Record<string, unknown>).me = { username: "testbot" };
    await startHandler(ctx);
    expect(ctx.reply).toHaveBeenCalled();
    const firstCall = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as unknown;
    expect(String(firstCall)).toMatch(/Welcome|manage/i);
  });

  it("in group chat: redirects to DM with button", async () => {
    const ctx = createMockCtx({ chatType: "supergroup" });
    (ctx as unknown as Record<string, unknown>).me = { username: "testbot" };
    await startHandler(ctx);
    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining("private chat"),
      expect.objectContaining({ reply_markup: expect.anything() as unknown }),
    );
  });
});

describe("/help command", () => {
  it("replies with command list", async () => {
    const ctx = createMockCtx();
    await helpHandler(ctx);
    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining("/newemail"),
      expect.objectContaining({ parse_mode: "HTML" }),
    );
  });
});
