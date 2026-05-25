import { describe, it, expect } from "vitest";
import {
  formatBytes,
  buildPrivacyAttachmentExpiry,
  renderEmailBodyHtml,
} from "../../../src/http/routes/view/templates.js";

describe("formatBytes", () => {
  it("formats bytes below 1 KB", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
  });

  it("formats values in KB range", () => {
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(2048)).toBe("2 KB");
  });

  it("formats values in MB range", () => {
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});

describe("buildPrivacyAttachmentExpiry", () => {
  const base = new Date("2026-01-01T00:00:00Z");

  it("returns attachment expiry when it is earlier", () => {
    // attachment TTL 24h, raw email TTL 48h → attachment expires first
    const result = buildPrivacyAttachmentExpiry(base, 24, 48);
    const expected = new Date(base.getTime() + 24 * 60 * 60 * 1000);
    expect(result).toEqual(expected);
  });

  it("returns raw email expiry when it is earlier", () => {
    // attachment TTL 48h, raw email TTL 24h → raw email expires first
    const result = buildPrivacyAttachmentExpiry(base, 48, 24);
    const expected = new Date(base.getTime() + 24 * 60 * 60 * 1000);
    expect(result).toEqual(expected);
  });
});

describe("renderEmailBodyHtml", () => {
  it("returns sanitized HTML when htmlBody is present", () => {
    const result = renderEmailBodyHtml({
      htmlBody: "<b>Hello</b><script>alert(1)</script>",
      textBody: null,
      attachments: [],
    } as never);
    expect(result).toContain("<b>Hello</b>");
    expect(result).not.toContain("<script>");
  });

  it("falls back to pre-escaped text when htmlBody is absent", () => {
    const result = renderEmailBodyHtml({
      htmlBody: null,
      textBody: "plain text",
      attachments: [],
    } as never);
    expect(result).toBe("<pre>plain text</pre>");
  });

  it("returns empty-body placeholder when both are absent", () => {
    const result = renderEmailBodyHtml({
      htmlBody: null,
      textBody: null,
      attachments: [],
    } as never);
    expect(result).toContain("empty body");
  });

  it("falls back to text when sanitised HTML is empty", () => {
    // A body with only script tags sanitises to an empty string
    const result = renderEmailBodyHtml({
      htmlBody: "<script>alert(1)</script>",
      textBody: "fallback text",
      attachments: [],
    } as never);
    expect(result).toBe("<pre>fallback text</pre>");
  });
});
