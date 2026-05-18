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
  return { ...actual, resolveLocale: vi.fn(() => Promise.resolve("en")) };
});

const { privacyHandler } = await import("../../../../src/telegram/commands/privacy.js");

describe("/privacy command", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders the policy with support contact and policy URL when configured", async () => {
    mockLoadConfig.mockReturnValue({
      supportContact: "@admin",
      privacyPolicyUrl: "https://example.com/privacy",
    });
    const ctx = createMockCtx({ chatType: "private" });

    await privacyHandler(ctx);

    expect(ctx.reply).toHaveBeenCalledTimes(1);
    const [text] = ctx.reply.mock.calls[0] as [string];
    expect(text).toContain("Privacy");
    expect(text).toContain("/delete_me");
    expect(text).toContain("@admin");
    expect(text).toContain("https://example.com/privacy");
  });

  it("omits contact and URL lines when neither is configured", async () => {
    mockLoadConfig.mockReturnValue({ supportContact: undefined, privacyPolicyUrl: undefined });
    const ctx = createMockCtx({ chatType: "private" });

    await privacyHandler(ctx);

    const [text] = ctx.reply.mock.calls[0] as [string];
    expect(text).not.toContain("Contact:");
    expect(text).not.toContain("Full policy:");
  });
});
