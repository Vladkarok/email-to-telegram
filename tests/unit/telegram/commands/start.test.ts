import { describe, it, expect } from "vitest";
import { startHandler } from "../../../../src/telegram/commands/start.js";
import { helpHandler } from "../../../../src/telegram/commands/help.js";
import { createMockCtx } from "../../../helpers/mockContext.js";

describe("/start command", () => {
  it("replies with welcome message", async () => {
    const ctx = createMockCtx();
    await startHandler(ctx);
    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining("Welcome"),
      expect.objectContaining({ parse_mode: "HTML" }),
    );
  });
});

describe("/help command", () => {
  it("replies with command list", async () => {
    const ctx = createMockCtx();
    await helpHandler(ctx);
    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining("/newemail"),
      expect.objectContaining({ parse_mode: "HTML" }),
    );
  });
});
