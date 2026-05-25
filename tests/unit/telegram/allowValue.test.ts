import { describe, it, expect } from "vitest";
import { parseAllowValue } from "../../../src/telegram/allowValue.js";

describe("parseAllowValue", () => {
  it("returns null for empty string", () => {
    expect(parseAllowValue("")).toBeNull();
    expect(parseAllowValue("   ")).toBeNull();
  });

  it("parses a valid email address", () => {
    const result = parseAllowValue("User@Example.COM");
    expect(result).toEqual({ normalized: "user@example.com", matchType: "exact_email" });
  });

  it("returns null for a malformed email (no TLD after @)", () => {
    expect(parseAllowValue("bad@noTLD")).toBeNull();
  });

  it("parses a valid domain", () => {
    const result = parseAllowValue("Example.COM");
    expect(result).toEqual({ normalized: "example.com", matchType: "domain" });
  });

  it("returns null for an invalid domain", () => {
    expect(parseAllowValue("not_a_domain")).toBeNull();
  });

  it("normalises input by trimming and lowercasing", () => {
    const result = parseAllowValue("  SENDER@DOMAIN.IO  ");
    expect(result?.normalized).toBe("sender@domain.io");
  });
});
