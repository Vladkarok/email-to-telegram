import { describe, it, expect, vi } from "vitest";
import { deleteemailHandler } from "../../../../src/telegram/commands/deleteemail.js";
import { createMockCtx } from "../../../helpers/mockContext.js";

vi.mock("../../../../src/db/client.js", () => ({ getDb: vi.fn(() => ({})) }));

const mockSoftDeleteAliasWithCas = vi.fn();
vi.mock("../../../../src/db/repos/aliasRouting.js", () => ({
  softDeleteAliasWithCas: (...args: unknown[]): unknown => mockSoftDeleteAliasWithCas(...args),
}));

const mockResolve = vi.fn();
vi.mock("../../../../src/telegram/aliasResolver.js", () => ({
  resolveManageableAlias: (...args: unknown[]): unknown => mockResolve(...args),
  aliasResolutionError: (
    result: { reason: "not_found" | "ambiguous" | "forbidden" },
    raw: string,
  ): string => {
    if (result.reason === "forbidden") return "⛔ Access denied.";
    if (result.reason === "ambiguous")
      return `❌ Alias <code>${raw}</code> matches more than one inbox.`;
    return `❌ Alias <code>${raw}</code> not found.`;
  },
}));

const resolvedAlias = {
  ok: true,
  alias: { id: "uuid-1", fullAddress: "alerts@example.com", routingVersion: 3 },
};

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
    mockResolve.mockResolvedValue(resolvedAlias);
    mockSoftDeleteAliasWithCas.mockResolvedValue({ ok: true, alias: resolvedAlias.alias });
    const ctx = createMockCtx({ commandMatch: "alerts" });
    await deleteemailHandler(ctx);
    // Deletion is version-guarded against the state the user was authorized on.
    expect(mockSoftDeleteAliasWithCas).toHaveBeenCalledWith(expect.anything(), {
      aliasId: "uuid-1",
      expectedVersion: 3,
    });
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("deleted"), expect.anything());
  });

  it("asks the user to retry when the alias was re-routed concurrently", async () => {
    mockResolve.mockResolvedValue(resolvedAlias);
    mockSoftDeleteAliasWithCas.mockResolvedValue({ ok: false, reason: "version_conflict" });
    const ctx = createMockCtx({ commandMatch: "alerts" });

    await deleteemailHandler(ctx);

    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("changed"), expect.anything());
    expect(ctx.reply).not.toHaveBeenCalledWith(
      expect.stringContaining("deleted"),
      expect.anything(),
    );
  });
});
