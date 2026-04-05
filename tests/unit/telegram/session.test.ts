import { describe, it, expect } from "vitest";
import { getPending, setPending, clearPending } from "../../../src/telegram/session.js";

describe("session", () => {
  it("returns undefined when no pending action is set", () => {
    expect(getPending(1)).toBeUndefined();
  });

  it("returns the pending action after setPending", () => {
    setPending(10, { action: "newemail", chatId: -100n, chatTitle: "My Group" });
    const p = getPending(10);
    expect(p?.action).toBe("newemail");
    if (p?.action === "newemail") {
      expect(p.chatId).toBe(-100n);
      expect(p.chatTitle).toBe("My Group");
    }
  });

  it("clears pending after clearPending", () => {
    setPending(20, { action: "newemail", chatId: -200n, chatTitle: "X" });
    clearPending(20);
    expect(getPending(20)).toBeUndefined();
  });

  it("clearPending is a no-op when nothing is pending", () => {
    expect(() => clearPending(9999)).not.toThrow();
  });

  it("stores PendingAllowRule action", () => {
    setPending(30, { action: "allowrule", aliasId: "abc-123", aliasLocalPart: "alerts" });
    const p = getPending(30);
    expect(p?.action).toBe("allowrule");
    if (p?.action === "allowrule") {
      expect(p.aliasId).toBe("abc-123");
      expect(p.aliasLocalPart).toBe("alerts");
    }
  });

  it("isolates sessions per userId", () => {
    setPending(40, { action: "newemail", chatId: -400n, chatTitle: "A" });
    setPending(41, { action: "newemail", chatId: -410n, chatTitle: "B" });
    expect(getPending(40)?.action).toBe("newemail");
    expect(getPending(41)?.action).toBe("newemail");
    clearPending(40);
    expect(getPending(40)).toBeUndefined();
    expect(getPending(41)).toBeDefined();
  });
});
