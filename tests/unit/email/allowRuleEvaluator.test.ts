import { describe, expect, it } from "vitest";
import { evaluateAllowRules } from "../../../src/email/allowRuleEvaluator.js";

const claimedDomain = {
  matchType: "domain",
  matchValue: "github.com",
  authRequirement: "claimed",
};

const authenticatedDomain = {
  matchType: "domain",
  matchValue: "github.com",
  authRequirement: "authenticated",
};

const authenticatedExact = {
  matchType: "exact_email",
  matchValue: "notifications@github.com",
  authRequirement: "authenticated",
};

describe("evaluateAllowRules", () => {
  it("allows an explicit claimed rule from the envelope sender", () => {
    expect(evaluateAllowRules([claimedDomain], "notifications@github.com")).toEqual({
      allowed: true,
      matchedAuthRequirement: "claimed",
    });
  });

  it("does not allow forged envelope sender for an authenticated domain rule", () => {
    expect(evaluateAllowRules([authenticatedDomain], "notifications@github.com")).toEqual({
      allowed: false,
      reason: "sender_not_allowed",
    });
  });

  it("allows an authenticated domain rule when RFC5322 From domain is authenticated", () => {
    expect(
      evaluateAllowRules([authenticatedDomain], "bounce@mailer.example", {
        headerFromEmail: "notifications@github.com",
        headerFromDomain: "github.com",
        authenticatedDomains: ["github.com"],
        status: "pass",
      }),
    ).toEqual({ allowed: true, matchedAuthRequirement: "authenticated" });
  });

  it("requires exact email match for authenticated exact-email rules", () => {
    expect(
      evaluateAllowRules([authenticatedExact], "bounce@mailer.example", {
        headerFromEmail: "security@github.com",
        headerFromDomain: "github.com",
        authenticatedDomains: ["github.com"],
        status: "pass",
      }),
    ).toEqual({ allowed: false, reason: "sender_not_allowed" });
  });

  it("returns a temporary reason for auth lookup errors when a candidate rule matches", () => {
    expect(
      evaluateAllowRules([authenticatedDomain], "bounce@mailer.example", {
        headerFromEmail: "notifications@github.com",
        headerFromDomain: "github.com",
        authenticatedDomains: [],
        status: "temperror",
      }),
    ).toEqual({ allowed: false, reason: "sender_auth_temperror" });
  });

  it("returns sender_auth_failed when candidate identity matches but auth does not pass", () => {
    expect(
      evaluateAllowRules([authenticatedDomain], "bounce@mailer.example", {
        headerFromEmail: "notifications@github.com",
        headerFromDomain: "github.com",
        authenticatedDomains: [],
        status: "fail",
      }),
    ).toEqual({ allowed: false, reason: "sender_auth_failed" });
  });
});
