import { beforeEach, describe, expect, it, vi } from "vitest";

const mockLoadConfig = vi.fn(() => ({ appMode: "hosted" }));

vi.mock("../../../src/config.js", () => ({
  loadConfig: (): unknown => mockLoadConfig(),
}));

const { AliasImpersonationError, assertAliasNotImpersonation } =
  await import("../../../src/abuse/aliasImpersonationGuard.js");

describe("assertAliasNotImpersonation (hosted mode)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env["APP_MODE"];
    mockLoadConfig.mockReturnValue({ appMode: "hosted" });
  });

  describe("exact-match blocklist (RFC 2142 + generic admins)", () => {
    it.each([
      "admin",
      "postmaster",
      "webmaster",
      "abuse",
      "security",
      "noreply",
      "no-reply",
      "support",
      "root",
      "hostmaster",
    ])("rejects exact-match: %s", (name) => {
      expect(() => assertAliasNotImpersonation(name)).toThrow(AliasImpersonationError);
    });

    it("rejects exact-match case-insensitively (validation happens lowercased downstream, but defend in depth)", () => {
      expect(() => assertAliasNotImpersonation("ADMIN")).toThrow(AliasImpersonationError);
      expect(() => assertAliasNotImpersonation("Postmaster")).toThrow(AliasImpersonationError);
    });
  });

  describe("brand-name substring list", () => {
    it.each([
      "paypal",
      "stripe-team",
      "amazonsupport",
      "google-help",
      "microsoft365",
      "myapple",
      "github-noreply",
      "facebook",
      "meta-billing",
      "instagram-help",
      "twitter",
      "tiktok",
      "youtube",
      "netflix",
      "spotify",
      "dropbox",
      "gitlab",
      "slack",
      "notion",
      "figma",
      "adobe",
      "coinbase",
      "binance",
      "kraken",
      "revolut",
      "wise",
      "chase",
      "bank",
      "barclays",
      "hsbc",
      "wellsfargo",
      "bankofamerica",
    ])("rejects brand substring: %s", (name) => {
      expect(() => assertAliasNotImpersonation(name)).toThrow(AliasImpersonationError);
    });
  });

  describe("prefix patterns", () => {
    it.each([
      "support-foo",
      "admin-foo",
      "noreply-anything",
      "no-reply-anything",
      "security-bar",
      "billing-bar",
      "payments-baz",
      "account-baz",
      "verify-qux",
    ])("rejects prefix pattern: %s", (name) => {
      expect(() => assertAliasNotImpersonation(name)).toThrow(AliasImpersonationError);
    });
  });

  describe("safe names pass", () => {
    it.each([
      "inbox",
      "alerts",
      "newsletters",
      "personal",
      "work",
      "mom",
      "myname123",
      "side-project",
      "alpha.beta",
      "test_box",
      "j",
      "a-very-long-but-fine-alias-32chars",
    ])("allows: %s", (name) => {
      expect(() => assertAliasNotImpersonation(name)).not.toThrow();
    });
  });

  describe("error carries a user-safe message", () => {
    it("AliasImpersonationError exposes a non-empty message", () => {
      try {
        assertAliasNotImpersonation("admin");
        throw new Error("expected throw");
      } catch (err) {
        expect(err).toBeInstanceOf(AliasImpersonationError);
        expect((err as Error).message.length).toBeGreaterThan(0);
      }
    });
  });
});

describe("assertAliasNotImpersonation (self-hosted mode)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env["APP_MODE"];
    mockLoadConfig.mockReturnValue({ appMode: "self-hosted" });
  });

  it("is a no-op in self-hosted mode — operator owns the namespace", () => {
    expect(() => assertAliasNotImpersonation("admin")).not.toThrow();
    expect(() => assertAliasNotImpersonation("support-paypal")).not.toThrow();
    expect(() => assertAliasNotImpersonation("paypal")).not.toThrow();
  });

  it("honors APP_MODE env override (env wins over loadConfig)", () => {
    process.env["APP_MODE"] = "self-hosted";
    mockLoadConfig.mockReturnValue({ appMode: "hosted" });
    expect(() => assertAliasNotImpersonation("admin")).not.toThrow();
  });

  it("falls back to no-op when loadConfig throws", () => {
    mockLoadConfig.mockImplementation(() => {
      throw new Error("config not loaded");
    });
    expect(() => assertAliasNotImpersonation("admin")).not.toThrow();
  });
});
