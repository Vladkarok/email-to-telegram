import { describe, expect, it } from "vitest";
import { evaluateAllowRules } from "../../../src/email/allowRuleEvaluator.js";

const domainRule = {
  matchType: "domain",
  matchValue: "github.com",
};

const exactRule = {
  matchType: "exact_email",
  matchValue: "notifications@github.com",
};

describe("evaluateAllowRules", () => {
  it("does not allow a matching rule without sender auth", () => {
    expect(evaluateAllowRules([domainRule])).toEqual({
      allowed: false,
      reason: "sender_not_allowed",
    });
  });

  it("allows an authenticated domain rule when RFC5322 From domain is authenticated", () => {
    expect(
      evaluateAllowRules([domainRule], {
        headerFromEmail: "notifications@github.com",
        headerFromDomain: "github.com",
        authenticatedDomains: ["github.com"],
        status: "pass",
      }),
    ).toEqual({ allowed: true });
  });

  it("requires exact email match for authenticated exact-email rules", () => {
    expect(
      evaluateAllowRules([exactRule], {
        headerFromEmail: "security@github.com",
        headerFromDomain: "github.com",
        authenticatedDomains: ["github.com"],
        status: "pass",
      }),
    ).toEqual({ allowed: false, reason: "sender_not_allowed" });
  });

  it("returns a temporary reason for auth lookup errors when a candidate rule matches", () => {
    expect(
      evaluateAllowRules([domainRule], {
        headerFromEmail: "notifications@github.com",
        headerFromDomain: "github.com",
        authenticatedDomains: [],
        status: "temperror",
      }),
    ).toEqual({ allowed: false, reason: "sender_auth_temperror" });
  });

  it("returns sender_auth_failed when candidate identity matches but auth does not pass", () => {
    expect(
      evaluateAllowRules([domainRule], {
        headerFromEmail: "notifications@github.com",
        headerFromDomain: "github.com",
        authenticatedDomains: [],
        status: "fail",
      }),
    ).toEqual({ allowed: false, reason: "sender_auth_failed" });
  });
});
