import { describe, it, expect, vi } from "vitest";
import { listemailHandler } from "../../../../src/telegram/commands/listemail.js";
import { createMockCtx } from "../../../helpers/mockContext.js";

vi.mock("../../../../src/db/client.js", () => ({ getDb: vi.fn(() => ({})) }));

const mockListAliases = vi.fn();
vi.mock("../../../../src/db/repos/aliases.js", () => ({
  listAliasesByChat: (...args: unknown[]): unknown => mockListAliases(...args),
}));

describe("/listemail command", () => {
  it("replies with 'no aliases' when chat has none", async () => {
    mockListAliases.mockResolvedValue([]);
    const ctx = createMockCtx();
    await listemailHandler(ctx);
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("No aliases"));
  });

  it("lists active aliases with full address and render mode", async () => {
    mockListAliases.mockResolvedValue([
      { fullAddress: "alerts@example.com", status: "active", renderMode: "html" },
      { fullAddress: "news@example.com", status: "paused", renderMode: "plaintext" },
    ]);
    const ctx = createMockCtx();
    await listemailHandler(ctx);
    const call = ctx.reply.mock.calls[0] as [string, unknown];
    expect(call[0]).toContain("alerts@example.com");
    expect(call[0]).toContain("news@example.com");
  });
});
