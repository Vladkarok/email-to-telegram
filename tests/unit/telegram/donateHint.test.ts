import { describe, expect, it } from "vitest";
import { donateHintSuffix } from "../../../src/telegram/donateHint.js";
import { getMessages } from "../../../src/i18n/index.js";
import type { AppConfig } from "../../../src/config.js";

const messages = getMessages("en");

function cfg(overrides: Partial<AppConfig>): AppConfig {
  return { billingProvider: "donation", donationUrl: undefined, ...overrides } as AppConfig;
}

describe("donateHintSuffix", () => {
  it("returns empty string when provider is not donation", () => {
    expect(
      donateHintSuffix(
        cfg({ billingProvider: "stripe", donationUrl: "https://x.test" }),
        messages,
        "plain",
      ),
    ).toBe("");
  });

  it("returns empty string when donationUrl is unset", () => {
    expect(donateHintSuffix(cfg({ donationUrl: undefined }), messages, "plain")).toBe("");
  });

  it("returns plain URL unchanged in plain mode (no &amp; mangling)", () => {
    const url = "https://buymeacoffee.com/x?utm_source=tg&utm_medium=bot";
    const out = donateHintSuffix(cfg({ donationUrl: url }), messages, "plain");
    expect(out).toContain(url);
    expect(out).not.toContain("&amp;");
  });

  it("escapes URL in html mode so it is safe inside parse_mode=HTML replies", () => {
    const url = "https://buymeacoffee.com/x?a=1&b=2";
    const out = donateHintSuffix(cfg({ donationUrl: url }), messages, "html");
    expect(out).toContain("a=1&amp;b=2");
    expect(out).not.toContain("a=1&b=2");
  });
});
