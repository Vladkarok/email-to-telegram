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
      const longBody = "x".repeat(4000);
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

    it("falls back to text body when htmlBody is null", () => {
      const result = renderEmail(BASE, "html", "alerts@example.com", []);
      expect(result).toContain("Hello, this is the email body.");
    });

    it("total length does not exceed 4096 chars", () => {
      const email = { ...BASE, htmlBody: "<p>" + "y".repeat(4000) + "</p>", textBody: null };
      const result = renderEmail(email, "html", "alerts@example.com", []);
      expect(result.length).toBeLessThanOrEqual(4096);
    });
  });

  describe("markdown mode", () => {
    it("renders plain-text body without parse_mode markup", () => {
      const result = renderEmail(BASE, "markdown", "alerts@example.com", []);
      expect(result).toContain("Hello, this is the email body.");
    });
  });
});
