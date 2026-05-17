import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockCtx } from "../../../helpers/mockContext.js";

const mockLoadConfig = vi.fn();
vi.mock("../../../../src/config.js", () => ({
  loadConfig: (): unknown => mockLoadConfig(),
}));

vi.mock("../../../../src/db/client.js", () => ({
  getDb: () => ({}),
}));

vi.mock("../../../../src/i18n/index.js", async () => {
  const actual = await vi.importActual<typeof import("../../../../src/i18n/index.js")>(
    "../../../../src/i18n/index.js",
  );
  return {
    ...actual,
    resolveLocale: vi.fn(() => Promise.resolve("en")),
  };
});

const { donateHandler } = await import("../../../../src/telegram/commands/donate.js");

const DONATION_URL = "https://buymeacoffee.com/vladkarok";

describe("/donate command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("replies with title, body, and inline button linking to DONATION_URL", async () => {
    mockLoadConfig.mockReturnValue({ billingProvider: "donation", donationUrl: DONATION_URL });
    const ctx = createMockCtx({ chatType: "private" });

    await donateHandler(ctx);

    expect(ctx.reply).toHaveBeenCalledTimes(1);
    const [text, options] = ctx.reply.mock.calls[0] as [
      string,
      { reply_markup: { inline_keyboard: { text: string; url: string }[][] } },
    ];
    expect(text).toContain("Support the project");
    expect(text).toContain("Donations are gifts");
    const button = options.reply_markup.inline_keyboard[0]?.[0];
    expect(button?.url).toBe(DONATION_URL);
    expect(button?.text).toContain("Donate");
  });

  it("replies with unavailable message when donationUrl is not set", async () => {
    mockLoadConfig.mockReturnValue({ billingProvider: "donation", donationUrl: undefined });
    const ctx = createMockCtx({ chatType: "private" });

    await donateHandler(ctx);

    expect(ctx.reply).toHaveBeenCalledTimes(1);
    const [text, options] = ctx.reply.mock.calls[0] as [string, unknown];
    expect(text).toContain("not configured");
    expect(options).toBeUndefined();
  });

  it("replies with unavailable when DONATION_URL is set but provider is not donation", async () => {
    mockLoadConfig.mockReturnValue({ billingProvider: "stripe", donationUrl: DONATION_URL });
    const ctx = createMockCtx({ chatType: "private" });

    await donateHandler(ctx);

    const [text, options] = ctx.reply.mock.calls[0] as [string, unknown];
    expect(text).toContain("not configured");
    expect(options).toBeUndefined();
  });
});
