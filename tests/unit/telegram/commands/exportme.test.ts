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
  EXPORT_SCHEMA_VERSION: 2,
}));

const { exportMeHandler, _resetExportCooldownForTests } =
  await import("../../../../src/telegram/commands/exportme.js");

describe("/export_me command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetExportCooldownForTests();
  });

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
    // First reply is "preparing"; second is the noData message.
    const replies = ctx.reply.mock.calls.map((c) => c[0] as string);
    expect(replies[0]).toContain("Preparing");
    expect(replies[1]).toContain("Nothing to export");
  });

  it("sends a JSON document with the export when data exists", async () => {
    const exportPayload = {
      schemaVersion: 2,
      exportedAt: "2026-05-18T10:00:00.000Z",
      user: { id: "123456789", username: "alice" },
      aliases: [],
    };
    mockExportHostedUserData.mockResolvedValue(exportPayload);
    const ctx = createMockCtx({ chatType: "private", fromId: 123456789 });

    await exportMeHandler(ctx);

    expect(ctx.reply).toHaveBeenCalledTimes(1);
    expect((ctx.reply.mock.calls[0] as [string])[0]).toContain("Preparing");
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
    const replies = ctx.reply.mock.calls.map((c) => c[0] as string);
    expect(replies.at(-1)).toContain("Export failed");
  });

  it("rate-limits repeated invocations from the same user", async () => {
    mockExportHostedUserData.mockResolvedValue({
      schemaVersion: 2,
      exportedAt: "2026-05-18T10:00:00.000Z",
      user: { id: "123456789" },
    });
    const ctx1 = createMockCtx({ chatType: "private", fromId: 999 });
    await exportMeHandler(ctx1);
    expect(ctx1.replyWithDocument).toHaveBeenCalledTimes(1);

    const ctx2 = createMockCtx({ chatType: "private", fromId: 999 });
    await exportMeHandler(ctx2);

    expect(ctx2.replyWithDocument).not.toHaveBeenCalled();
    const [text] = ctx2.reply.mock.calls[0] as [string];
    expect(text).toMatch(/Please wait \d+s/);
    // exportHostedUserData should have been called once for ctx1 only.
    expect(mockExportHostedUserData).toHaveBeenCalledTimes(1);
  });

  it("keeps the cooldown when the user has no data", async () => {
    mockExportHostedUserData.mockResolvedValue(null);
    const ctx1 = createMockCtx({ chatType: "private", fromId: 555 });
    await exportMeHandler(ctx1);

    const ctx2 = createMockCtx({ chatType: "private", fromId: 555 });
    await exportMeHandler(ctx2);

    expect(mockExportHostedUserData).toHaveBeenCalledTimes(1);
    const replies = ctx2.reply.mock.calls.map((c) => c[0] as string);
    expect(replies.some((r) => r.startsWith("⏳ Please wait"))).toBe(true);
  });

  it("does not lock the cooldown when the export throws", async () => {
    mockExportHostedUserData.mockRejectedValueOnce(new Error("transient")).mockResolvedValueOnce({
      schemaVersion: 2,
      exportedAt: "2026-05-18T10:00:00.000Z",
      user: { id: "777" },
    });
    const ctx1 = createMockCtx({ chatType: "private", fromId: 777 });
    await exportMeHandler(ctx1);

    const ctx2 = createMockCtx({ chatType: "private", fromId: 777 });
    await exportMeHandler(ctx2);

    expect(mockExportHostedUserData).toHaveBeenCalledTimes(2);
    expect(ctx2.replyWithDocument).toHaveBeenCalledTimes(1);
  });

  it("rejects exports larger than the Telegram upload cap", async () => {
    // 50 MiB+ payload. JSON.stringify on a long string will exceed MAX_EXPORT_BYTES.
    const huge = "x".repeat(50 * 1024 * 1024 + 1024);
    mockExportHostedUserData.mockResolvedValue({
      schemaVersion: 2,
      exportedAt: "2026-05-18T10:00:00.000Z",
      user: { id: "1", notes: huge },
    });
    const ctx = createMockCtx({ chatType: "private", fromId: 1 });

    await exportMeHandler(ctx);

    expect(ctx.replyWithDocument).not.toHaveBeenCalled();
    const replies = ctx.reply.mock.calls.map((c) => c[0] as string);
    expect(replies.at(-1)).toContain("too large");
  });
});
