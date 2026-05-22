import { describe, it, expect } from "vitest";
import { cleanEmailBody } from "../../../src/email/cleaner.js";

describe("cleanEmailBody", () => {
  it("returns body unchanged when no quotes or signature", () => {
    const text = "Hello, this is a simple message.\nNo quotes here.";
    expect(cleanEmailBody(text)).toBe(text);
  });

  it("strips RFC 3676 signature delimiter (-- \\n)", () => {
    const text = "Main message content.\n\n-- \nJohn Smith\nSupport Engineer";
    const result = cleanEmailBody(text);
    expect(result.trim()).toBe("Main message content.");
    expect(result).not.toContain("John Smith");
  });

  it("strips signature starting with '--\\n' (no trailing space)", () => {
    const text = "Ticket resolved.\n\n--\nJohn Smith\nExample Corp";
    const result = cleanEmailBody(text);
    expect(result.trim()).toBe("Ticket resolved.");
  });

  it("strips quoted reply lines starting with >", () => {
    const text =
      "Sounds good!\n\nOn Friday, Boss wrote:\n> Can everyone join?\n> Room B.\n> Thanks.";
    const result = cleanEmailBody(text);
    expect(result).toContain("Sounds good!");
    expect(result).not.toContain("> Can everyone join?");
  });

  it("strips 'On ... wrote:' attribution line", () => {
    const text =
      "Reply here.\n\nOn Fri, 3 Apr 2026 at 10:00, Boss <boss@example.com> wrote:\n> Quote";
    const result = cleanEmailBody(text);
    expect(result.trim()).toBe("Reply here.");
  });

  it("preserves legitimate > characters in code blocks", () => {
    // A > at the start of a code context should be stripped if it looks like a quote
    // This is a known limitation — we prefer false positive stripping over showing noise
    const text = "Result: > 5\nDone.";
    const result = cleanEmailBody(text);
    // Lines starting with > stripped, but "Result: > 5" doesn't start with >
    expect(result).toContain("Result: > 5");
  });

  it("preserves a benign mid-body sentence containing 'wrote:'", () => {
    // A real sentence that starts a line with "On " and contains "wrote:" with
    // inline text after the colon must NOT be treated as a quoted-reply marker.
    const text =
      "Reply text here.\nOn Monday Sarah wrote: please check the attached file.\nThanks, see you soon.";
    const result = cleanEmailBody(text);
    expect(result).toContain("Thanks, see you soon.");
    expect(result).toContain("On Monday Sarah wrote: please check");
  });

  it("strips a two-line 'On ... wrote:' attribution block", () => {
    const text =
      "My answer.\nOn Wed, 6 May 2026 at 09:00\nBob <bob@example.com> wrote:\n> original message\n> more quoted";
    const result = cleanEmailBody(text);
    expect(result.trim()).toBe("My answer.");
    expect(result).not.toContain("original message");
  });

  it("handles empty string", () => {
    expect(cleanEmailBody("")).toBe("");
  });

  it("trims leading and trailing whitespace from result", () => {
    const text = "\n\nHello world.\n\n";
    expect(cleanEmailBody(text)).toBe("Hello world.");
  });
});
