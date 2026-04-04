import { describe, it, expect } from "vitest";
import { renderEmail } from "../../../src/email/renderer.js";
import type { ParsedEmail } from "../../../src/email/types.js";

const BASE: ParsedEmail = {
  messageId: "<test@example.com>",
  subject: "Test Subject",
  envelopeFrom: "sender@example.com",
  headerFrom: "Sender <sender@example.com>",
  textBody: "Hello, this is the email body.",
  htmlBody: null,
  bodySha256: "abc123",
  attachments: [],
  rawSizeBytes: 500,
};

describe("renderEmail", () => {
  describe("plaintext mode", () => {
    it("renders metadata header and text body", () => {
      const result = renderEmail(BASE, "plaintext", "alerts-abc@tgmail.example.com", []);
      expect(result).toContain("sender@example.com");
      expect(result).toContain("Test Subject");
      expect(result).toContain("Hello, this is the email body.");
    });

    it("strips HTML tags when only HTML body is available", () => {
      const email = { ...BASE, textBody: null, htmlBody: "<p>HTML content</p>" };
      const result = renderEmail(email, "plaintext", "alerts@example.com", []);
      expect(result).toContain("HTML content");
      expect(result).not.toContain("<p>");
    });

    it("truncates long body and appends truncation notice", () => {
      const longBody = "x".repeat(4100);
      const email = { ...BASE, textBody: longBody };
      const result = renderEmail(email, "plaintext", "alerts@example.com", []);
      expect(result.length).toBeLessThanOrEqual(4096);
      expect(result).toContain("truncated");
    });

    it("includes attachment download links when present", () => {
      const attachmentLinks = [
        { filename: "report.pdf", sizeBytes: 42000, url: "https://example.com/dl/token1" },
      ];
      const result = renderEmail(BASE, "plaintext", "alerts@example.com", attachmentLinks);
      expect(result).toContain("report.pdf");
      expect(result).toContain("https://example.com/dl/token1");
    });

    it("never truncates attachment links even with a long body", () => {
      const longBody = "x".repeat(4100);
      const email = { ...BASE, textBody: longBody };
      const url = "https://mail.example.com/dl/" + "a".repeat(96);
      const attachmentLinks = [{ filename: "file.pdf", sizeBytes: 100, url }];
      const result = renderEmail(email, "plaintext", "alerts@example.com", attachmentLinks);
      expect(result.length).toBeLessThanOrEqual(4096);
      expect(result).toContain(url); // full URL is always present
    });
  });

  describe("html mode", () => {
    it("preserves safe HTML tags", () => {
      const email = { ...BASE, htmlBody: "<p>Hello <b>world</b></p>", textBody: null };
      const result = renderEmail(email, "html", "alerts@example.com", []);
      expect(result).toContain("<b>world</b>");
    });

    it("strips dangerous tags (script)", () => {
      const email = {
        ...BASE,
        htmlBody: "<p>Safe</p><script>alert('xss')</script>",
        textBody: null,
      };
      const result = renderEmail(email, "html", "alerts@example.com", []);
      expect(result).not.toContain("<script>");
      expect(result).not.toContain("alert(");
    });

    it("falls back to HTML-escaped text body when htmlBody is null", () => {
      const result = renderEmail(BASE, "html", "alerts@example.com", []);
      // The plain-text body has no HTML special chars — should be present unchanged
      expect(result).toContain("Hello, this is the email body.");
    });

    it("HTML-escapes angle brackets in plain-text fallback body", () => {
      const email = { ...BASE, textBody: "Error: <nil> pointer at line 42", htmlBody: null };
      const result = renderEmail(email, "html", "alerts@example.com", []);
      expect(result).toContain("&lt;nil&gt;");
      expect(result).not.toContain("<nil>");
    });

    it("HTML-escapes angle brackets in From/Subject header", () => {
      const email = { ...BASE, headerFrom: "Alice <alice@example.com>" };
      const result = renderEmail(email, "html", "alerts@example.com", []);
      expect(result).toContain("Alice &lt;alice@example.com&gt;");
      expect(result).not.toContain("<alice@example.com>");
    });

    it("total length does not exceed 4096 chars", () => {
      const email = { ...BASE, htmlBody: "<p>" + "y".repeat(4000) + "</p>", textBody: null };
      const result = renderEmail(email, "html", "alerts@example.com", []);
      expect(result.length).toBeLessThanOrEqual(4096);
    });
  });

  describe("markdown mode", () => {
    it("escapes MarkdownV2 special characters in body", () => {
      const email = {
        ...BASE,
        textBody: "Build [123] failed. See foo_bar and baz.qux!",
      };
      const result = renderEmail(email, "markdown", "alerts@example.com", []);
      // [ ] . _ ! must all be escaped
      expect(result).toContain("\\[123\\]");
      expect(result).toContain("foo\\_bar");
      expect(result).toContain("baz\\.qux\\!");
    });

    it("escapes angle brackets in header From field", () => {
      const email = { ...BASE, headerFrom: "Alice <alice@example.com>" };
      const result = renderEmail(email, "markdown", "alerts@example.com", []);
      expect(result).toContain("Alice \\<alice@example\\.com\\>");
    });

    it("renders plain-text body content (with escaping)", () => {
      const result = renderEmail(BASE, "markdown", "alerts@example.com", []);
      // "Hello, this is the email body." has a trailing . which is escaped
      expect(result).toContain("Hello, this is the email body\\.");
    });
  });
});
