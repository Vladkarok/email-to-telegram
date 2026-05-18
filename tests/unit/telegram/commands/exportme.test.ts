import { beforeEach, describe, expect, it, vi } from "vitest";
import { InputFile } from "grammy";
import { createMockCtx } from "../../../helpers/mockContext.js";

vi.mock("../../../../src/db/client.js", () => ({
  getDb: () => ({}),
}));

vi.mock("../../../../src/i18n/index.js", async () => {
  const actual = await vi.importActual<typeof import("../../../../src/i18n/index.js")>(
    "../../../../src/i18n/index.js",
  );
  return { ...actual, resolveLocale: vi.fn(() => Promise.resolve("en")) };
});

const mockExportHostedUserData = vi.fn();
vi.mock("../../../../src/dataLifecycle/exportUser.js", () => ({
  exportHostedUserData: (...args: unknown[]): unknown => mockExportHostedUserData(...args),
}));

const { exportMeHandler } = await import("../../../../src/telegram/commands/exportme.js");

describe("/export_me command", () => {
  beforeEach(() => vi.clearAllMocks());

  it("ignores invocations outside private chat", async () => {
    const ctx = createMockCtx({ chatType: "supergroup" });
    await exportMeHandler(ctx);
    expect(ctx.reply).not.toHaveBeenCalled();
    expect(ctx.replyWithDocument).not.toHaveBeenCalled();
    expect(mockExportHostedUserData).not.toHaveBeenCalled();
  });

  it("replies with noData when the user has no row", async () => {
    mockExportHostedUserData.mockResolvedValue(null);
    const ctx = createMockCtx({ chatType: "private" });

    await exportMeHandler(ctx);

    expect(ctx.replyWithDocument).not.toHaveBeenCalled();
    const [text] = ctx.reply.mock.calls[0] as [string];
    expect(text).toContain("Nothing to export");
  });

  it("sends a JSON document with the export when data exists", async () => {
    const exportPayload = {
      exportedAt: "2026-05-18T10:00:00.000Z",
      user: { id: "123456789", username: "alice" },
      aliases: [],
    };
    mockExportHostedUserData.mockResolvedValue(exportPayload);
    const ctx = createMockCtx({ chatType: "private", fromId: 123456789 });

    await exportMeHandler(ctx);

    expect(ctx.reply).not.toHaveBeenCalled();
    expect(ctx.replyWithDocument).toHaveBeenCalledTimes(1);
    const [file, opts] = ctx.replyWithDocument.mock.calls[0] as [InputFile, { caption: string }];
    expect(file).toBeInstanceOf(InputFile);
    expect(file.filename).toBe("email-to-telegram-export-123456789-2026-05-18.json");
    expect(opts.caption).toContain("JSON");
  });

  it("replies with failed message when export throws", async () => {
    mockExportHostedUserData.mockRejectedValue(new Error("db down"));
    const ctx = createMockCtx({ chatType: "private" });

    await exportMeHandler(ctx);

    expect(ctx.replyWithDocument).not.toHaveBeenCalled();
    const [text] = ctx.reply.mock.calls[0] as [string];
    expect(text).toContain("Export failed");
  });
});
