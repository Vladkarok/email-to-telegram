import { describe, it, expect, vi } from "vitest";
import { deleteemailHandler } from "../../../../src/telegram/commands/deleteemail.js";
import { createMockCtx } from "../../../helpers/mockContext.js";

vi.mock("../../../../src/db/client.js", () => ({ getDb: vi.fn(() => ({})) }));

const mockFindAlias = vi.fn();
const mockUpdateStatus = vi.fn();
vi.mock("../../../../src/db/repos/aliases.js", () => ({
  findAliasByIdAndChat: (...args: unknown[]): unknown => mockFindAlias(...args),
  updateAliasStatus: (...args: unknown[]): unknown => mockUpdateStatus(...args),
}));

vi.mock("../../../../src/telegram/authorization.js", () => ({
  canManageAlias: vi.fn().mockResolvedValue(true),
  canManageChat: vi.fn().mockResolvedValue(true),
}));

describe("/deleteemail command", () => {
  it("shows usage when no argument given", async () => {
    const ctx = createMockCtx({ commandMatch: "" });
    await deleteemailHandler(ctx);
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("Usage"));
  });

  it("replies with error when alias not found", async () => {
    mockFindAlias.mockResolvedValue(null);
    const ctx = createMockCtx({ commandMatch: "alerts" });
    await deleteemailHandler(ctx);
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("not found"), expect.anything());
  });

  it("marks alias deleted and confirms", async () => {
    mockFindAlias.mockResolvedValue({ id: "uuid-1", fullAddress: "alerts@example.com" });
    mockUpdateStatus.mockResolvedValue(undefined);
    const ctx = createMockCtx({ commandMatch: "alerts" });
    await deleteemailHandler(ctx);
    expect(mockUpdateStatus).toHaveBeenCalledWith(expect.anything(), "uuid-1", "deleted");
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("deleted"), expect.anything());
  });
});
