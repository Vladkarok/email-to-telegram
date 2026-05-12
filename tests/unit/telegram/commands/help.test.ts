import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockCtx } from "../../../helpers/mockContext.js";

const mockLoadConfig = vi.fn(() => ({ appMode: "hosted", billingProvider: "stripe" }));
vi.mock("../../../../src/config.js", () => ({
  loadConfig: (): unknown => mockLoadConfig(),
}));

const { helpHandler } = await import("../../../../src/telegram/commands/help.js");

describe("/help command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadConfig.mockReturnValue({ appMode: "hosted", billingProvider: "stripe" });
  });

  it("shows Stripe billing commands when self-serve billing is enabled", async () => {
    const ctx = createMockCtx({ chatType: "private" });

    await helpHandler(ctx);

    const [text] = ctx.reply.mock.calls[0] as [string];
    expect(text).toContain("/upgrade");
    expect(text).toContain("/portal");
    expect(text).toContain("/language");
    expect(text).toMatch(/Stripe checkout|billing portal/i);
  });

  it("shows plan and usage only in hosted manual billing mode", async () => {
    mockLoadConfig.mockReturnValue({ appMode: "hosted", billingProvider: "none" });
    const ctx = createMockCtx({ chatType: "private" });

    await helpHandler(ctx);

    const [text] = ctx.reply.mock.calls[0] as [string];
    expect(text).toContain("/billing");
    expect(text).toContain("/plan");
    expect(text).toContain("/usage");
    expect(text).not.toContain("/upgrade");
    expect(text).not.toContain("/portal");
  });

  it("omits hosted plan and billing commands in self-hosted mode", async () => {
    mockLoadConfig.mockReturnValue({ appMode: "self-hosted", billingProvider: "none" });
    const ctx = createMockCtx({ chatType: "private" });

    await helpHandler(ctx);

    const [text] = ctx.reply.mock.calls[0] as [string];
    expect(text).not.toContain("/billing");
    expect(text).not.toContain("/plan");
    expect(text).not.toContain("/usage");
    expect(text).not.toContain("/upgrade");
    expect(text).not.toContain("/portal");
  });
});
