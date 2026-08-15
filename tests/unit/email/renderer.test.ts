import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { renderEmail, renderEmailForDelivery } from "../../../src/email/renderer.js";
import type { ParsedEmail } from "../../../src/email/types.js";

const BASE: ParsedEmail = {
  messageId: "<test@example.com>",
  subject: "Test Subject",
  envelopeFrom: "sender@example.com",
  headerFrom: "Sender <sender@example.com>",
  headerFromEmail: "sender@example.com",
  headerFromDomain: "example.com",
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

  describe("html mode attachments", () => {
    it("renders attachment as <a> link with HTML-escaped filename", () => {
      const attachmentLinks = [
        {
          filename: "report <Q&A>.pdf",
          sizeBytes: 1000,
          url: "https://example.com/dl/token1",
        },
      ];
      const result = renderEmail(BASE, "html", "alerts@example.com", attachmentLinks);
      expect(result).toContain('<a href="https://example.com/dl/token1">');
      expect(result).toContain("report &lt;Q&amp;A&gt;.pdf");
      expect(result).not.toContain("<Q&A>");
    });

    it("total length does not exceed 4096 even when many attachments are present", () => {
      const manyLinks = Array.from({ length: 40 }, (_, i) => ({
        filename: `attachment-with-long-name-${i}.pdf`,
        sizeBytes: 100,
        url: `https://example.com/dl/${"a".repeat(64)}${i}`,
      }));
      const result = renderEmail(BASE, "html", "alerts@example.com", manyLinks);
      expect(result.length).toBeLessThanOrEqual(4096);
      expect(result.match(/<a\b/g)?.length ?? 0).toBe(result.match(/<\/a>/g)?.length ?? 0);
    });
  });

  describe("markdown mode attachments", () => {
    it("renders attachment as HTML link with an escaped filename", () => {
      const attachmentLinks = [
        {
          filename: "report <final>.pdf",
          sizeBytes: 1000,
          url: "https://example.com/dl/token1",
        },
      ];
      const result = renderEmail(BASE, "markdown", "alerts@example.com", attachmentLinks);
      expect(result).toContain('<a href="https://example.com/dl/token1">');
      expect(result).toContain("report &lt;final&gt;.pdf");
      expect(result).not.toContain("report <final>.pdf");
    });

    it("total length does not exceed 4096 even when many attachments are present", () => {
      const manyLinks = Array.from({ length: 40 }, (_, i) => ({
        filename: `attachment_long_name_${i}.pdf`,
        sizeBytes: 100,
        url: `https://example.com/dl/${"a".repeat(64)}${i}`,
      }));
      const result = renderEmail(BASE, "markdown", "alerts@example.com", manyLinks);
      expect(result.length).toBeLessThanOrEqual(4096);
      expect(result.match(/<a\b/g)?.length ?? 0).toBe(result.match(/<\/a>/g)?.length ?? 0);
    });
  });

  describe("html mode", () => {
    it("preserves safe HTML tags", () => {
      const email = { ...BASE, htmlBody: "<p>Hello <b>world</b></p>", textBody: null };
      const result = renderEmail(email, "html", "alerts@example.com", []);
      expect(result).toContain("<b>world</b>");
    });

    it("keeps readable line breaks for block HTML elements", () => {
      const email = {
        ...BASE,
        htmlBody: "<p>Hello</p><p>World</p><ul><li>First</li><li>Second</li></ul>",
        textBody: null,
      };
      const result = renderEmail(email, "html", "alerts@example.com", []);
      expect(result).toContain("Hello\n\nWorld");
      expect(result).toContain("• First");
      expect(result).toContain("• Second");
    });

    it("renders compact HTML tables as mobile-first records", () => {
      const email = {
        ...BASE,
        htmlBody: [
          "<table>",
          "<tr><th>Name</th><th>Status</th><th>Duration</th></tr>",
          "<tr><td>KM-1C</td><td>Warning</td><td>00:02:29</td></tr>",
          "</table>",
        ].join(""),
        textBody: null,
      };
      const result = renderEmail(email, "html", "alerts@example.com", []);
      expect(result).not.toContain("<pre>");
      expect(result).toContain("<b>KM-1C</b>");
      expect(result).toContain("Status");
      expect(result).toContain("KM-1C");
      expect(result).toContain("Warning");
      expect(result).toContain("Duration");
    });

    it("renders wide HTML tables as stacked records without truncation", () => {
      const email = {
        ...BASE,
        htmlBody: [
          "<table>",
          "<tr><th>Name</th><th>Status</th><th>Start</th><th>End</th><th>Size</th><th>Details</th></tr>",
          "<tr><td>KM-1C</td><td>Warning</td><td>23:30:01</td><td>23:32:30</td><td>251.7 GB</td><td>There is not enough space on the disk.</td></tr>",
          "</table>",
        ].join(""),
        textBody: null,
      };
      const result = renderEmail(email, "html", "alerts@example.com", []);
      expect(result).not.toContain("<pre>");
      expect(result).toContain("<b>KM-1C</b>");
      expect(result).toContain("Status: Warning");
      expect(result).toContain("Details: There is not enough space on the disk.");
      expect(result).not.toContain("Name    |");
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
    it("renders common markdown syntax as Telegram-safe HTML", () => {
      const email = {
        ...BASE,
        textBody: [
          "# Release Notes",
          "",
          "Use **bold**, _italic_, and ~~strike~~.",
          "",
          "- first item",
          "2. second item",
          "> quoted line",
          "",
          "Open [docs](https://example.com/docs) and run `npm test`.",
          "",
          "```",
          "const ok = true;",
          "```",
        ].join("\n"),
      };
      const result = renderEmail(email, "markdown", "alerts@example.com", []);
      expect(result).toContain("<b>Release Notes</b>");
      expect(result).toContain("<b>bold</b>");
      expect(result).toContain("<i>italic</i>");
      expect(result).toContain("<s>strike</s>");
      expect(result).toContain("• first item");
      expect(result).toContain("2. second item");
      expect(result).toContain("&gt; quoted line");
      expect(result).toContain('<a href="https://example.com/docs">docs</a>');
      expect(result).toContain("<code>npm test</code>");
      expect(result).toContain("<pre>const ok = true;</pre>");
    });

    it("prefers the HTML body when the plain-text body is not markdown-authored", () => {
      const email = {
        ...BASE,
        textBody: "Hello team\n\nThis came from a rich-text composer.",
        htmlBody: "<p>Hello <b>team</b></p><blockquote>Quoted</blockquote><ul><li>First</li></ul>",
      };
      const result = renderEmail(email, "markdown", "alerts@example.com", []);
      expect(result).toContain("<b>team</b>");
      expect(result).toContain("Quoted");
      expect(result).toContain("• First");
    });

    it("keeps ordinary plain text when the HTML alternative has no visible content", () => {
      const email = {
        ...BASE,
        textBody: "Plain fallback survives",
        htmlBody: '<img src="https://tracker.example/pixel.png">',
      };

      const result = renderEmail(email, "markdown", "alerts@example.com", []);

      expect(result).toContain("Plain fallback survives");
    });

    it("keeps plain text when bounded HTML contains only dropped media and an omission notice", () => {
      const email = {
        ...BASE,
        textBody: "Plain fallback survives truncation",
        htmlBody: "<img>".repeat(20_001),
      };

      const result = renderEmail(email, "markdown", "alerts@example.com", []);

      expect(result).toContain("Plain fallback survives truncation");
      expect(result).not.toContain("content omitted");
    });

    it("groups Markdown list runs into native rich lists", () => {
      const rendered = renderEmailForDelivery(
        { ...BASE, textBody: "- alpha\n- beta\n- gamma", htmlBody: null },
        "markdown",
        "alerts@example.com",
        [],
      );

      expect(rendered.text).toContain("• alpha\n• beta\n• gamma");
      expect(rendered.richHtml).toContain("<ul><li>alpha</li><li>beta</li><li>gamma</li></ul>");
    });

    it("preserves the starting number of Markdown ordered lists", () => {
      const rendered = renderEmailForDelivery(
        { ...BASE, textBody: "2. second\n3. third", htmlBody: null },
        "markdown",
        "alerts@example.com",
        [],
      );

      expect(rendered.text).toContain("2. second\n3. third");
      expect(rendered.richHtml).toContain('<ol start="2"><li>second</li><li>third</li></ol>');
    });

    it("treats repeated ordered Markdown markers as one list", () => {
      const rendered = renderEmailForDelivery(
        { ...BASE, textBody: "1. first\n1. second\n1. third", htmlBody: null },
        "markdown",
        "alerts@example.com",
        [],
      );

      expect(rendered.text).toContain("1. first\n2. second\n3. third");
      expect(rendered.richHtml).toContain("<ol><li>first</li><li>second</li><li>third</li></ol>");
    });

    it("keeps soft-wrapped Markdown paragraph lines in one paragraph", () => {
      const result = renderEmail(
        { ...BASE, textBody: "**Status** first line\ncontinues here", htmlBody: null },
        "markdown",
        "alerts@example.com",
        [],
      );

      expect(result).toContain("<b>Status</b> first line continues here");
      expect(result).not.toContain("first line\n\ncontinues");
    });

    it("keeps HTML tables readable when markdown mode falls back to the HTML body", () => {
      const email = {
        ...BASE,
        textBody: "Backup report attached below.",
        htmlBody: [
          "<table>",
          "<tr><th>Name</th><th>Status</th><th>Transferred</th></tr>",
          "<tr><td>KM-1C</td><td>Warning</td><td>14.9 GB</td></tr>",
          "</table>",
        ].join(""),
      };
      const result = renderEmail(email, "markdown", "alerts@example.com", []);
      expect(result).not.toContain("<pre>");
      expect(result).toContain("<b>KM-1C</b>");
      expect(result).toContain("Status");
      expect(result).toContain("14.9 GB");
    });

    it("prefers markdown-authored plain text over an HTML wrapper copy", () => {
      const email = {
        ...BASE,
        textBody: "# Heading\n\n**Bold** and `code`",
        htmlBody: "<div># Heading</div><div>**Bold** and `code`</div>",
      };
      const result = renderEmail(email, "markdown", "alerts@example.com", []);
      expect(result).toContain("<b>Heading</b>");
      expect(result).toContain("<b>Bold</b>");
      expect(result).toContain("<code>code</code>");
    });

    it("HTML-escapes angle brackets in the header", () => {
      const email = { ...BASE, headerFrom: "Alice <alice@example.com>" };
      const result = renderEmail(email, "markdown", "alerts@example.com", []);
      expect(result).toContain("Alice &lt;alice@example.com&gt;");
    });
  });

  describe("plaintext mode table fallback", () => {
    it("keeps table values readable when HTML is stripped to text", () => {
      const email = {
        ...BASE,
        textBody: null,
        htmlBody: [
          "<table>",
          "<tr><th>Name</th><th>Status</th></tr>",
          "<tr><td>KM-1C</td><td>Warning</td></tr>",
          "</table>",
        ].join(""),
      };
      const result = renderEmail(email, "plaintext", "alerts@example.com", []);
      expect(result).toContain("Status");
      expect(result).toContain("KM-1C");
      expect(result).toContain("Warning");
      expect(result).not.toContain("<table>");
    });
  });

  describe("delivery rendering", () => {
    it("renders a Veeam-style report as native tables plus a mobile-first fallback", () => {
      const htmlBody = readFileSync(
        new URL("../../fixtures/veeam-report.html", import.meta.url),
        "utf8",
      );
      const rendered = renderEmailForDelivery(
        { ...BASE, textBody: "Backup report", htmlBody },
        "markdown",
        "alerts@example.com",
        [],
      );

      expect(rendered.text).not.toContain("<pre>");
      expect(rendered.text).not.toContain("<br>");
      expect(rendered.text).toContain("<b>Start time:</b> 10:00:18");
      expect(rendered.text).toContain(
        "Configuration catalog with a deliberately long untruncated name",
      );
      expect(rendered.richHtml).toContain("<h2>Configuration Backup for Admins</h2>");
      expect(rendered.richHtml?.match(/<table>/g)).toHaveLength(2);
      expect(rendered.richHtml).toContain(
        "<footer>Veeam Backup &amp; Replication 13.1.0.411</footer>",
      );
    });

    it("keeps messages with source links on classic transport", () => {
      const rendered = renderEmailForDelivery(
        {
          ...BASE,
          textBody: null,
          htmlBody: '<p>Open <a href="https://example.com">report</a></p>',
        },
        "html",
        "alerts@example.com",
        [],
      );

      expect(rendered.text).toContain("<a href=");
      expect(rendered.richHtml).toBeUndefined();
    });

    it("keeps plain source URLs on classic transport", () => {
      const rendered = renderEmailForDelivery(
        { ...BASE, textBody: null, htmlBody: "<p>Open https://example.com/report</p>" },
        "html",
        "alerts@example.com",
        [],
      );

      expect(rendered.richHtml).toBeUndefined();
    });

    it("keeps source URLs next to punctuation on classic transport", () => {
      const rendered = renderEmailForDelivery(
        { ...BASE, textBody: null, htmlBody: "<p>Open(https://example.com/report)</p>" },
        "html",
        "alerts@example.com",
        [],
      );

      expect(rendered.richHtml).toBeUndefined();
    });

    it("keeps attachment links on classic transport", () => {
      const rendered = renderEmailForDelivery(
        { ...BASE, textBody: null, htmlBody: "<p>Report</p>" },
        "html",
        "alerts@example.com",
        [{ filename: "report.pdf", sizeBytes: 1, url: "https://example.com/dl/1" }],
      );

      expect(rendered.text).toContain("report.pdf");
      expect(rendered.richHtml).toBeUndefined();
    });
  });
});
