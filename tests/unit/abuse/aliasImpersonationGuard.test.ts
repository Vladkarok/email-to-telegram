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

    it("rejects exact-match case-insensitively (defense in depth — NAME_RE upstream is lowercase-only)", () => {
      expect(() => assertAliasNotImpersonation("ADMIN")).toThrow(AliasImpersonationError);
      expect(() => assertAliasNotImpersonation("Postmaster")).toThrow(AliasImpersonationError);
    });
  });

  describe("brand-name substring list (long, ≥6 chars)", () => {
    it.each([
      "paypal",
      "stripe-team",
      "amazonsupport",
      "google-help",
      "microsoft365",
      "github-noreply",
      "facebook",
      "instagram-help",
      "twitter",
      "tiktok",
      "youtube",
      "netflix",
      "spotify",
      "dropbox",
      "gitlab",
      "coinbase",
      "binance",
      "kraken",
      "revolut",
      "barclays",
      "wellsfargo",
      "bankofamerica",
      // added in review #3
      "telegram-support",
      "discord-alerts",
      "whatsapp-noreply",
      "shopify-billing",
      "cloudflare-security",
    ])("rejects long-brand substring: %s", (name) => {
      expect(() => assertAliasNotImpersonation(name)).toThrow(AliasImpersonationError);
    });
  });

  describe("brand-name short list (boundary-anchored)", () => {
    it.each([
      "meta",
      "bank",
      "wise",
      "chase",
      "apple",
      "hsbc",
      "slack",
      "adobe",
      "figma",
      "notion",
      "meta-help",
      "bank.alert",
      "wise.support",
      "chase-news",
      "apple-pie",
      "data-meta",
      "news.bank",
    ])("rejects short brand at boundary: %s", (name) => {
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

  describe("leading/trailing separator edge cases in prefix matching", () => {
    it.each(["admin.", "admin..", "no--reply"])(
      "rejects prefix with edge-case separators: %s",
      (name) => {
        expect(() => assertAliasNotImpersonation(name)).toThrow(AliasImpersonationError);
      },
    );
  });

  describe("separator-split bypass (CRITICAL — review finding)", () => {
    it.each([
      "pay.pal",
      "pay-pal",
      "p_aypal",
      "str.ipe",
      "g-oogle",
      "app.le",
      "b-a-n-k",
      "m-e-t-a",
      "git.hub",
      "face.book",
      "in_sta_gram",
    ])("rejects separator-split: %s", (name) => {
      expect(() => assertAliasNotImpersonation(name)).toThrow(AliasImpersonationError);
    });
  });

  describe("dot-suffix bypass on prefix list (CRITICAL — review finding)", () => {
    it.each([
      "admin.x",
      "support.x",
      "noreply.service",
      "no-reply.x",
      "security.alert",
      "billing.info",
      "verify.me",
      "account.info",
      "payments.info",
    ])("rejects dot-suffix prefix bypass: %s", (name) => {
      expect(() => assertAliasNotImpersonation(name)).toThrow(AliasImpersonationError);
    });
  });

  describe("leet-speak bypass (HIGH — review finding)", () => {
    it.each([
      "g00gle",
      "adm1n",
      "supp0rt",
      "m1crosoft",
      "p4ypal",
      "stripe3", // trailing leet noise
      "n0reply",
      "amaz0n",
      "f4cebook",
      "m3ta-help", // leet + boundary
      "app1e",
      // multi-1 combos — git1ab / netf11x require 2^k expansion (HIGH from review #2)
      "git1ab",
      "g1t1ab",
      "netf11x",
    ])("rejects leet-speak: %s", (name) => {
      expect(() => assertAliasNotImpersonation(name)).toThrow(AliasImpersonationError);
    });
  });

  describe("digit-boundary on short brands and prefix list", () => {
    it.each(["admin1", "account9", "verify123", "apple1", "bank2025", "slack4"])(
      "rejects digit immediately after match: %s",
      (name) => {
        expect(() => assertAliasNotImpersonation(name)).toThrow(AliasImpersonationError);
      },
    );
  });

  describe("false-positive prevention: legitimate names with brand-overlap survive", () => {
    it.each([
      "metabolism",
      "metadata",
      "metamorphic",
      "metallica",
      "banking",
      "bankrupt",
      "databank",
      "riverbank",
      "otherwise",
      "likewise",
      "clockwise",
      "pineapple",
      "appleton",
      "snapple",
      "myapple",
      "chaser",
      "purchase",
      "slacker",
      "slackline",
      "configuration",
      "notional",
      "emotional",
      // prefix false-positive prevention (MEDIUM from review #2)
      // continuous English letters after the prefix = not blocked
      "administrator",
      "accountant",
      "accounting",
      "billings",
      "adminx", // letter after prefix = English continuation
      // app1ex: 1→l gives applex (not apple), 1→i gives appie (not apple) — intentionally allowed
      "app1ex",
    ])("allows English word with brand overlap: %s", (name) => {
      expect(() => assertAliasNotImpersonation(name)).not.toThrow();
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
      "ya_hoo", // yahoo is not on any blocklist
      "linkedin", // not on the blocklist either
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
    expect(() => assertAliasNotImpersonation("pay.pal")).not.toThrow();
    expect(() => assertAliasNotImpersonation("g00gle")).not.toThrow();
  });

  it("honors APP_MODE=self-hosted env override (env wins over loadConfig=hosted)", () => {
    process.env["APP_MODE"] = "self-hosted";
    mockLoadConfig.mockReturnValue({ appMode: "hosted" });
    expect(() => assertAliasNotImpersonation("admin")).not.toThrow();
  });

  it("honors APP_MODE=hosted env override (env wins over loadConfig=self-hosted)", () => {
    process.env["APP_MODE"] = "hosted";
    mockLoadConfig.mockReturnValue({ appMode: "self-hosted" });
    expect(() => assertAliasNotImpersonation("admin")).toThrow(AliasImpersonationError);
  });

  it("falls back to no-op when loadConfig throws", () => {
    mockLoadConfig.mockImplementation(() => {
      throw new Error("config not loaded");
    });
    expect(() => assertAliasNotImpersonation("admin")).not.toThrow();
  });
});
