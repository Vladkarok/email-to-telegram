import { describe, it, expect, vi } from "vitest";
import { pauseemailHandler } from "../../../../src/telegram/commands/pauseemail.js";
import { resumeemailHandler } from "../../../../src/telegram/commands/resumeemail.js";
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
    if (result.reason === "ambiguous")
      return `❌ Alias <code>${raw}</code> matches more than one inbox.`;
    return `❌ Alias <code>${raw}</code> not found.`;
  },
}));

describe("/pauseemail command", () => {
  it("shows usage when no argument", async () => {
    const ctx = createMockCtx({ commandMatch: "" });
    await pauseemailHandler(ctx);
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("Usage"));
  });

  it("replies not found when alias missing", async () => {
    mockResolve.mockResolvedValue({ ok: false, reason: "not_found" });
    const ctx = createMockCtx({ commandMatch: "alerts" });
    await pauseemailHandler(ctx);
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("not found"), expect.anything());
  });

  it("notifies when alias is already paused", async () => {
    mockResolve.mockResolvedValue({
      ok: true,
      alias: { id: "uuid-1", fullAddress: "alerts@example.com", status: "paused" },
    });
    const ctx = createMockCtx({ commandMatch: "alerts" });
    await pauseemailHandler(ctx);
    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining("already paused"),
      expect.anything(),
    );
    expect(mockUpdateStatus).not.toHaveBeenCalled();
  });

  it("pauses an active alias and confirms", async () => {
    mockResolve.mockResolvedValue({
      ok: true,
      alias: { id: "uuid-2", fullAddress: "news@example.com", status: "active" },
    });
    mockUpdateStatus.mockResolvedValue(undefined);
    const ctx = createMockCtx({ commandMatch: "news" });
    await pauseemailHandler(ctx);
    expect(mockUpdateStatus).toHaveBeenCalledWith(expect.anything(), "uuid-2", "paused");
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("paused"), expect.anything());
  });
});

describe("/resumeemail command", () => {
  it("shows usage when no argument", async () => {
    const ctx = createMockCtx({ commandMatch: "" });
    await resumeemailHandler(ctx);
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("Usage"));
  });

  it("notifies when alias is already active", async () => {
    mockResolve.mockResolvedValue({
      ok: true,
      alias: { id: "uuid-3", fullAddress: "alerts@example.com", status: "active" },
    });
    const ctx = createMockCtx({ commandMatch: "alerts" });
    await resumeemailHandler(ctx);
    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining("already active"),
      expect.anything(),
    );
  });

  it("resumes a paused alias and confirms", async () => {
    mockResolve.mockResolvedValue({
      ok: true,
      alias: { id: "uuid-4", fullAddress: "news@example.com", status: "paused" },
    });
    mockUpdateStatus.mockResolvedValue(undefined);
    const ctx = createMockCtx({ commandMatch: "news" });
    await resumeemailHandler(ctx);
    expect(mockUpdateStatus).toHaveBeenCalledWith(expect.anything(), "uuid-4", "active");
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("resumed"), expect.anything());
  });
});
