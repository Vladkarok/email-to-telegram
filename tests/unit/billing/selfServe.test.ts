import { describe, expect, it } from "vitest";
import { manualBillingMessage, resolveSupportContact } from "../../../src/billing/selfServe.js";
import { getMessages } from "../../../src/i18n/index.js";

const messages = getMessages("en");

describe("manualBillingMessage", () => {
  it("uses the donation copy when the provider is donation — never sells plans", () => {
    const text = manualBillingMessage(
      { supportContact: "@operator", billingProvider: "donation" },
      messages,
    );
    expect(text).toBe(messages.billingCommands.manualBillingDonation("@operator"));
    // Legal constraint of the donation model: donations are gifts, not
    // payment for service — the copy must not read as a price list.
    expect(text).toContain("/donate");
    expect(text).not.toMatch(/\$\d/);
  });

  it("uses the operator-managed copy for other providers without self-serve", () => {
    const text = manualBillingMessage(
      { supportContact: "@operator", billingProvider: "none" },
      messages,
    );
    expect(text).toBe(messages.billingCommands.manualBilling("@operator"));
  });

  it("HTML-escapes the support contact (rendered with parse_mode HTML in /billing)", () => {
    const text = manualBillingMessage(
      { supportContact: "ops <team>", billingProvider: "donation" },
      messages,
    );
    expect(text).toContain("ops &lt;team&gt;");
  });
});

describe("resolveSupportContact", () => {
  it("falls back to a generic contact when none is configured", () => {
    expect(resolveSupportContact({ supportContact: null })).toBe("support");
    expect(resolveSupportContact({ supportContact: "@me" })).toBe("@me");
  });
});
