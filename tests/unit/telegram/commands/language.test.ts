import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockCtx } from "../../../helpers/mockContext.js";

vi.mock("../../../../src/db/client.js", () => ({ getDb: vi.fn(() => ({})) }));

const mockFindUserById = vi.fn();
const mockUpdateUserLocale = vi.fn();
class MockLocaleColumnUnavailableError extends Error {}
vi.mock("../../../../src/db/repos/users.js", () => ({
  LocaleColumnUnavailableError: MockLocaleColumnUnavailableError,
  findUserById: (...args: unknown[]): unknown => mockFindUserById(...args),
  isLocaleColumnUnavailableError: (err: unknown): boolean =>
    err instanceof MockLocaleColumnUnavailableError,
  updateUserLocale: (...args: unknown[]): unknown => mockUpdateUserLocale(...args),
}));

const { languageCallbackHandler, languageHandler } =
  await import("../../../../src/telegram/commands/language.js");

describe("/language command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindUserById.mockResolvedValue(null);
    mockUpdateUserLocale.mockResolvedValue(undefined);
  });

  it("shows language choices with the current Telegram fallback selected", async () => {
    const ctx = createMockCtx({ chatType: "private", languageCode: "uk" });

    await languageHandler(ctx);

    const [text, opts] = ctx.reply.mock.calls[0] as [
      string,
      { parse_mode?: string; reply_markup?: { inline_keyboard?: unknown[][] } },
    ];
    expect(text).toContain("Мова");
    expect(opts.parse_mode).toBe("HTML");
    expect(JSON.stringify(opts.reply_markup)).toContain("lang:uk");
    expect(JSON.stringify(opts.reply_markup)).toContain("✓ Українська");
  });

  it("prefers stored locale over Telegram language", async () => {
    mockFindUserById.mockResolvedValue({ locale: "en" });
    const ctx = createMockCtx({ chatType: "private", languageCode: "uk" });

    await languageHandler(ctx);

    const [text, opts] = ctx.reply.mock.calls[0] as [
      string,
      { reply_markup?: { inline_keyboard?: unknown[][] } },
    ];
    expect(text).toContain("Language");
    expect(JSON.stringify(opts.reply_markup)).toContain("✓ English");
  });

  it("stores locale from callback and redraws the picker", async () => {
    const ctx = createMockCtx({ chatType: "private" });
    ctx.match = ["lang:uk", "uk"] as unknown as typeof ctx.match;

    await languageCallbackHandler(ctx);

    expect(mockUpdateUserLocale).toHaveBeenCalledWith(expect.anything(), 123456789n, "uk");
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(expect.stringContaining("Українська"));
    expect(ctx.editMessageText).toHaveBeenCalledWith(
      expect.stringContaining("Мова"),
      expect.objectContaining({ parse_mode: "HTML" }),
    );
  });

  it("reports temporary unavailability when the locale column is missing", async () => {
    mockUpdateUserLocale.mockRejectedValue(new MockLocaleColumnUnavailableError());
    const ctx = createMockCtx({ chatType: "private" });
    ctx.match = ["lang:uk", "uk"] as unknown as typeof ctx.match;

    await languageCallbackHandler(ctx);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(expect.stringContaining("міграція"));
    expect(ctx.editMessageText).not.toHaveBeenCalled();
  });
});
