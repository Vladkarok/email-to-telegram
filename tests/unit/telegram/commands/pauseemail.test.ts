import { describe, it, expect, vi } from "vitest";
import { pauseemailHandler } from "../../../../src/telegram/commands/pauseemail.js";
import { resumeemailHandler } from "../../../../src/telegram/commands/resumeemail.js";
import { createMockCtx } from "../../../helpers/mockContext.js";

vi.mock("../../../../src/db/client.js", () => ({ getDb: vi.fn(() => ({})) }));

const mockFindAlias = vi.fn();
const mockUpdateStatus = vi.fn();
vi.mock("../../../../src/db/repos/aliases.js", () => ({
  findAliasByIdAndChat: (...args: unknown[]): unknown => mockFindAlias(...args),
  updateAliasStatus: (...args: unknown[]): unknown => mockUpdateStatus(...args),
}));

describe("/pauseemail command", () => {
  it("shows usage when no argument", async () => {
    const ctx = createMockCtx({ commandMatch: "" });
    await pauseemailHandler(ctx);
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("Usage"));
  });

  it("replies not found when alias missing", async () => {
    mockFindAlias.mockResolvedValue(null);
    const ctx = createMockCtx({ commandMatch: "alerts" });
    await pauseemailHandler(ctx);
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("not found"), expect.anything());
  });

  it("notifies when alias is already paused", async () => {
    mockFindAlias.mockResolvedValue({
      id: "uuid-1",
      fullAddress: "alerts@example.com",
      status: "paused",
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
    mockFindAlias.mockResolvedValue({
      id: "uuid-2",
      fullAddress: "news@example.com",
      status: "active",
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
    mockFindAlias.mockResolvedValue({
      id: "uuid-3",
      fullAddress: "alerts@example.com",
      status: "active",
    });
    const ctx = createMockCtx({ commandMatch: "alerts" });
    await resumeemailHandler(ctx);
    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining("already active"),
      expect.anything(),
    );
  });

  it("resumes a paused alias and confirms", async () => {
    mockFindAlias.mockResolvedValue({
      id: "uuid-4",
      fullAddress: "news@example.com",
      status: "paused",
    });
    mockUpdateStatus.mockResolvedValue(undefined);
    const ctx = createMockCtx({ commandMatch: "news" });
    await resumeemailHandler(ctx);
    expect(mockUpdateStatus).toHaveBeenCalledWith(expect.anything(), "uuid-4", "active");
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("resumed"), expect.anything());
  });
});
