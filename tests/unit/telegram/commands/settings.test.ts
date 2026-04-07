import { describe, it, expect, vi } from "vitest";
import { settingsHandler } from "../../../../src/telegram/commands/settings.js";
import { createMockCtx } from "../../../helpers/mockContext.js";

vi.mock("../../../../src/db/client.js", () => ({ getDb: vi.fn(() => ({})) }));

const mockFindAlias = vi.fn();
const mockUpdateMode = vi.fn();
const mockUpdateBodyDedup = vi.fn();
const mockUpdatePrivacyMode = vi.fn();
vi.mock("../../../../src/db/repos/aliases.js", () => ({
  findAliasByIdAndChat: (...args: unknown[]): unknown => mockFindAlias(...args),
  updateAliasRenderMode: (...args: unknown[]): unknown => mockUpdateMode(...args),
  updateAliasBodyDedup: (...args: unknown[]): unknown => mockUpdateBodyDedup(...args),
  updateAliasPrivacyMode: (...args: unknown[]): unknown => mockUpdatePrivacyMode(...args),
}));

vi.mock("../../../../src/telegram/authorization.js", () => ({
  canManageAlias: vi.fn().mockResolvedValue(true),
  canManageChat: vi.fn().mockResolvedValue(true),
}));

describe("/settings command", () => {
  it("shows usage when no argument", async () => {
    const ctx = createMockCtx({ commandMatch: "" });
    await settingsHandler(ctx);
    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining("body dedup on"),
      expect.objectContaining({ parse_mode: "HTML" }),
    );
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
      privacyModeEnabled: false,
      bodyDedupEnabled: false,
    });
    mockUpdateMode.mockResolvedValue(undefined);
    const ctx = createMockCtx({ commandMatch: "alerts html" });
    await settingsHandler(ctx);
    expect(mockUpdateMode).toHaveBeenCalledWith(expect.anything(), "uuid-1", "html");
    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining("Do not type raw HTML tags"),
      expect.anything(),
    );
  });

  it("applies body dedup directly when given as argument", async () => {
    mockFindAlias.mockResolvedValue({
      id: "uuid-1",
      fullAddress: "alerts@example.com",
      renderMode: "plaintext",
      privacyModeEnabled: false,
      bodyDedupEnabled: false,
    });
    mockUpdateBodyDedup.mockResolvedValue(undefined);
    const ctx = createMockCtx({ commandMatch: "alerts dedup on" });
    await settingsHandler(ctx);
    expect(mockUpdateBodyDedup).toHaveBeenCalledWith(expect.anything(), "uuid-1", true);
    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining("Message-ID duplicates are still blocked"),
      expect.anything(),
    );
  });

  it("applies privacy mode directly when given as argument", async () => {
    mockFindAlias.mockResolvedValue({
      id: "uuid-1",
      fullAddress: "alerts@example.com",
      renderMode: "plaintext",
      privacyModeEnabled: false,
      bodyDedupEnabled: false,
    });
    mockUpdatePrivacyMode.mockResolvedValue(undefined);
    const ctx = createMockCtx({ commandMatch: "alerts privacy on" });
    await settingsHandler(ctx);
    expect(mockUpdatePrivacyMode).toHaveBeenCalledWith(expect.anything(), "uuid-1", true);
    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining("browser view link"),
      expect.anything(),
    );
  });

  it("shows inline keyboard when no mode argument", async () => {
    mockFindAlias.mockResolvedValue({
      id: "uuid-2",
      fullAddress: "news@example.com",
      renderMode: "plaintext",
      privacyModeEnabled: false,
      bodyDedupEnabled: false,
    });
    const ctx = createMockCtx({ commandMatch: "news" });
    await settingsHandler(ctx);
    const call = ctx.reply.mock.calls[0] as [string, { reply_markup: unknown }];
    expect(call[0]).toContain("send literal text exactly as typed");
    expect(call[0]).toContain("Privacy mode: <b>off</b>");
    expect(call[0]).toContain("Body dedup: <b>off</b>");
    expect(call[1]).toHaveProperty("reply_markup");
  });
});
