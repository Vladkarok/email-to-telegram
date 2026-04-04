import { describe, it, expect, vi } from "vitest";
import { settingsHandler } from "../../../../src/telegram/commands/settings.js";
import { createMockCtx } from "../../../helpers/mockContext.js";

vi.mock("../../../../src/db/client.js", () => ({ getDb: vi.fn(() => ({})) }));

const mockFindAlias = vi.fn();
const mockUpdateMode = vi.fn();
vi.mock("../../../../src/db/repos/aliases.js", () => ({
  findAliasByIdAndChat: (...args: unknown[]): unknown => mockFindAlias(...args),
  updateAliasRenderMode: (...args: unknown[]): unknown => mockUpdateMode(...args),
}));

describe("/settings command", () => {
  it("shows usage when no argument", async () => {
    const ctx = createMockCtx({ commandMatch: "" });
    await settingsHandler(ctx);
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("Usage"));
  });

  it("replies not found when alias missing", async () => {
    mockFindAlias.mockResolvedValue(null);
    const ctx = createMockCtx({ commandMatch: "alerts" });
    await settingsHandler(ctx);
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("not found"), expect.anything());
  });

  it("applies render mode directly when given as argument", async () => {
    mockFindAlias.mockResolvedValue({
      id: "uuid-1",
      fullAddress: "alerts@example.com",
      renderMode: "plaintext",
    });
    mockUpdateMode.mockResolvedValue(undefined);
    const ctx = createMockCtx({ commandMatch: "alerts html" });
    await settingsHandler(ctx);
    expect(mockUpdateMode).toHaveBeenCalledWith(expect.anything(), "uuid-1", "html");
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("html"), expect.anything());
  });

  it("shows inline keyboard when no mode argument", async () => {
    mockFindAlias.mockResolvedValue({
      id: "uuid-2",
      fullAddress: "news@example.com",
      renderMode: "plaintext",
    });
    const ctx = createMockCtx({ commandMatch: "news" });
    await settingsHandler(ctx);
    const call = ctx.reply.mock.calls[0] as [string, { reply_markup: unknown }];
    expect(call[1]).toHaveProperty("reply_markup");
  });
});
