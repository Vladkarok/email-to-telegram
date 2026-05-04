import { describe, it, expect, vi } from "vitest";
import { deleteemailHandler } from "../../../../src/telegram/commands/deleteemail.js";
import { createMockCtx } from "../../../helpers/mockContext.js";

vi.mock("../../../../src/db/client.js", () => ({ getDb: vi.fn(() => ({})) }));

const mockUpdateStatus = vi.fn();
vi.mock("../../../../src/db/repos/aliases.js", () => ({
  updateAliasStatus: (...args: unknown[]): unknown => mockUpdateStatus(...args),
}));

const mockResolve = vi.fn();
vi.mock("../../../../src/telegram/aliasResolver.js", () => ({
  resolveManageableAlias: (...args: unknown[]): unknown => mockResolve(...args),
  aliasResolutionError: (
    result: { reason: "not_found" | "ambiguous" | "forbidden" },
    raw: string,
  ): string => {
    if (result.reason === "forbidden") return "⛔ Access denied.";
    if (result.reason === "ambiguous") return `❌ Alias <code>${raw}</code> matches more than one inbox.`;
    return `❌ Alias <code>${raw}</code> not found.`;
  },
}));

describe("/deleteemail command", () => {
  it("shows usage when no argument given", async () => {
    const ctx = createMockCtx({ commandMatch: "" });
    await deleteemailHandler(ctx);
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("Usage"));
  });

  it("replies with error when alias not found", async () => {
    mockResolve.mockResolvedValue({ ok: false, reason: "not_found" });
    const ctx = createMockCtx({ commandMatch: "alerts" });
    await deleteemailHandler(ctx);
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("not found"), expect.anything());
  });

  it("marks alias deleted and confirms", async () => {
    mockResolve.mockResolvedValue({
      ok: true,
      alias: { id: "uuid-1", fullAddress: "alerts@example.com" },
    });
    mockUpdateStatus.mockResolvedValue(undefined);
    const ctx = createMockCtx({ commandMatch: "alerts" });
    await deleteemailHandler(ctx);
    expect(mockUpdateStatus).toHaveBeenCalledWith(expect.anything(), "uuid-1", "deleted");
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("deleted"), expect.anything());
  });
});
