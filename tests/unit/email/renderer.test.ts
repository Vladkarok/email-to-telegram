import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { parseEmail } from "../../../src/email/parser.js";
import {
  normalizeRenderMode,
  renderEmail,
  renderEmailForDelivery,
  type RenderMode,
} from "../../../src/email/renderer.js";
import type { ParsedEmail } from "../../../src/email/types.js";

const BASE: ParsedEmail = {
  messageId: "<test@example.com>",
  subject: "Test Subject",
  envelopeFrom: "sender@example.com",
  headerFrom: '"Sender" <sender@example.com>',
  headerFromDisplay: "Sender <sender@example.com>",
  headerFromEmail: "sender@example.com",
  headerFromDomain: "example.com",
  textBody: "Hello, this is the email body.",
  htmlBody: null,
  bodySha256: "abc123",
  attachments: [],
  rawSizeBytes: 500,
};

describe("normalizeRenderMode", () => {
  it("maps stored values to the two supported modes", () => {
    expect(normalizeRenderMode("html")).toBe("html");
    expect(normalizeRenderMode("markdown")).toBe("html");
    expect(normalizeRenderMode("plaintext")).toBe("plaintext");
    expect(normalizeRenderMode(null)).toBe("plaintext");
    expect(normalizeRenderMode(undefined)).toBe("plaintext");
    expect(normalizeRenderMode("rich")).toBe("plaintext");
  });
});

describe("renderEmail", () => {
  describe("plaintext mode", () => {
    it("renders metadata header and text body", () => {
      const result = renderEmail(BASE, "plaintext", "alerts-abc@tgmail.example.com", []);
      expect(result.startsWith("From: ")).toBe(true);
      expect(result).not.toContain("<blockquote>");
      expect(result).not.toContain("<b>");
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
      const email = { ...BASE, headerFromDisplay: "Alice <alice@example.com>" };
      const result = renderEmail(email, "html", "alerts@example.com", []);
      expect(result).toContain("Alice &lt;alice@example.com&gt;");
      expect(result).not.toContain("<alice@example.com>");
    });

    it("wraps the classic header in a quote block with bold labels", () => {
      const result = renderEmail(BASE, "html", "alerts@example.com", []);
      expect(result.startsWith("<blockquote><b>From:</b> ")).toBe(true);
      expect(result).toContain("\n<b>To:</b> alerts@example.com\n<b>Subject:</b> ");
      expect(result).toContain("</blockquote>\n\n");
      expect(result).not.toContain("<hr>");
    });

    it("caps an oversized subject so the header never forces the last-resort slice", () => {
      const email = { ...BASE, subject: "s".repeat(4200), htmlBody: "<p>Body</p>", textBody: null };
      const result = renderEmail(email, "html", "alerts@example.com", []);
      expect(result.length).toBeLessThanOrEqual(4096);
      expect(result.startsWith("<blockquote><b>From:</b> ")).toBe(true);
      expect(result).toContain("</blockquote>\n\nBody");
      expect(result).toContain(`${"s".repeat(511)}…`);
      expect(result).not.toContain("s".repeat(512));
      expect(result).not.toContain("&gt; ");
    });

    it("rich header is a quote block followed by a divider", () => {
      const email = { ...BASE, htmlBody: "<p>Body</p>", textBody: null };
      const rendered = renderEmailForDelivery(email, "html", "alerts@example.com", []);
      expect(rendered.richHtml?.startsWith("<blockquote><b>From:</b> ")).toBe(true);
      expect(rendered.richHtml).toContain("<br><b>To:</b> alerts@example.com<br><b>Subject:</b> ");
      expect(rendered.richHtml).toContain("</blockquote><hr><p>Body</p>");
    });

    it("total length does not exceed 4096 chars", () => {
      const email = { ...BASE, htmlBody: "<p>" + "y".repeat(4000) + "</p>", textBody: null };
      const result = renderEmail(email, "html", "alerts@example.com", []);
      expect(result.length).toBeLessThanOrEqual(4096);
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
        "html",
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
      expect(rendered.richHtml?.match(/<table bordered compact>/g)).toHaveLength(2);
      expect(rendered.richHtml).toContain(
        "<footer>Veeam Backup &amp; Replication 13.1.0.411</footer>",
      );
    });

    it("gives a text-only email the rich frame with paragraphs and line breaks", () => {
      const rendered = renderEmailForDelivery(
        {
          ...BASE,
          htmlBody: null,
          textBody:
            "EVENT TYPE: Illegal Login\nNVR: 28 Che <b>4</b>\n\nSee https://example.com/nvr.",
        },
        "html",
        "alerts@example.com",
        [],
      );

      expect(rendered.text).toContain(
        "EVENT TYPE: Illegal Login\nNVR: 28 Che &lt;b&gt;4&lt;/b&gt;",
      );
      expect(rendered.richHtml).toContain(
        "</blockquote><hr><p>EVENT TYPE: Illegal Login<br>NVR: 28 Che &lt;b&gt;4&lt;/b&gt;</p>" +
          '<p>See <a href="https://example.com/nvr">https://example.com/nvr</a>.</p>',
      );
    });

    it("keeps plaintext mode literal on classic but still sends the rich frame", () => {
      const rendered = renderEmailForDelivery(
        { ...BASE, htmlBody: "<p>Hello <b>there</b></p>", textBody: null },
        "plaintext",
        "alerts@example.com",
        [],
      );

      expect(rendered.parseMode).toBeUndefined();
      expect(rendered.text.startsWith("From: ")).toBe(true);
      expect(rendered.text).toContain("Hello there");
      expect(rendered.richHtml?.startsWith("<blockquote><b>From:</b> ")).toBe(true);
      expect(rendered.richHtml).toContain("</blockquote><hr><p>Hello there</p>");
    });

    it("splits paragraphs on blank lines that carry spaces, tabs or NBSP, and keeps markup literal", () => {
      const rendered = renderEmailForDelivery(
        { ...BASE, htmlBody: null, textBody: "a\r\n \r\nb\n\t\nc\n\u00a0\n<p>&amp;</p>" },
        "html",
        "alerts@example.com",
        [],
      );

      expect(rendered.richHtml).toContain(
        "</blockquote><hr><p>a</p><p>b</p><p>c</p><p>&lt;p&gt;&amp;amp;&lt;/p&gt;</p>",
      );
      expect(rendered.text).toContain("a\r\n \r\nb\n\t\nc\n\u00a0\n&lt;p&gt;&amp;amp;&lt;/p&gt;");
    });

    it("falls back to classic when a text email has more paragraphs than the rich block budget", () => {
      const fits = renderEmailForDelivery(
        {
          ...BASE,
          htmlBody: null,
          textBody: Array.from({ length: 498 }, (_, i) => `p${i}`).join("\n\n"),
        },
        "html",
        "alerts@example.com",
        [],
      );
      const over = renderEmailForDelivery(
        {
          ...BASE,
          htmlBody: null,
          textBody: Array.from({ length: 499 }, (_, i) => `p${i}`).join("\n\n"),
        },
        "html",
        "alerts@example.com",
        [],
      );

      expect(fits.richHtml).toBeDefined();
      expect(over.richHtml).toBeUndefined();
    });

    it("sends no rich frame for an empty body", () => {
      const rendered = renderEmailForDelivery(
        { ...BASE, htmlBody: null, textBody: "   \n\n  " },
        "html",
        "alerts@example.com",
        [],
      );

      expect(rendered.richHtml).toBeUndefined();
    });

    it("renders source links on the rich transport", () => {
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

      expect(rendered.text).toContain('<a href="https://example.com/">report</a>');
      expect(rendered.richHtml).toContain('<p>Open <a href="https://example.com/">report</a></p>');
    });

    it("linkifies bare URLs in rich output and leaves classic text to Telegram", () => {
      const rendered = renderEmailForDelivery(
        { ...BASE, textBody: null, htmlBody: "<p>Open https://example.com/report.</p>" },
        "html",
        "alerts@example.com",
        [],
      );

      expect(rendered.text).toContain("Open https://example.com/report.");
      expect(rendered.text).not.toContain("<a href");
      expect(rendered.richHtml).toContain(
        '<p>Open <a href="https://example.com/report">https://example.com/report</a>.</p>',
      );
    });

    it("lists attachment links in a rich paragraph with the same URLs as classic", () => {
      const links = [
        { filename: "report.pdf", sizeBytes: 10, url: "https://example.net/dl/a" },
        { filename: "evil\nname\u0007.txt", sizeBytes: 10, url: "https://example.net/dl/b" },
      ];
      const rendered = renderEmailForDelivery(
        { ...BASE, textBody: null, htmlBody: "<p>Body</p>" },
        "html",
        "alerts@example.com",
        links,
      );

      expect(rendered.text).toContain('<a href="https://example.net/dl/a">report.pdf</a>');
      expect(rendered.richHtml).toContain(
        '<p>Body</p><p><b>Attachments:</b><br><a href="https://example.net/dl/a">report.pdf</a>' +
          '<br><a href="https://example.net/dl/b">evil name .txt</a></p>',
      );
    });

    it("strips directional controls from attachment filenames", () => {
      const rendered = renderEmailForDelivery(
        { ...BASE, textBody: null, htmlBody: "<p>Body</p>" },
        "html",
        "alerts@example.com",
        [{ filename: "invoice\u202efdp.exe", sizeBytes: 1, url: "https://example.net/dl/a" }],
      );

      expect(rendered.richHtml).toContain('<a href="https://example.net/dl/a">invoicefdp.exe</a>');
    });

    it("omits exactly the attachments that do not fit the remaining text budget", () => {
      // "Attachments:" is 12 characters and each entry costs 1 + name length, so
      // three 30-character names need 105 characters while two of them plus the
      // 20-character notice need 95. A budget of 100 keeps two and omits one.
      const headerText =
        "From: Sender <sender@example.com>\nTo: alerts@example.com\nSubject: Test Subject";
      const body = "x".repeat(32768 - 100 - headerText.length);
      const links = ["a", "b", "c"].map((letter) => ({
        filename: letter.repeat(30),
        sizeBytes: 1,
        url: `https://example.net/dl/${letter}`,
      }));
      const rendered = renderEmailForDelivery(
        { ...BASE, textBody: null, htmlBody: `<p>${body}</p>` },
        "html",
        "alerts@example.com",
        links,
      );

      expect(rendered.richHtml).toMatch(/dl\/a".*dl\/b".*<br>1 attachment omitted<\/p>$/);
      expect(rendered.richHtml).not.toContain("dl/c");
    });

    it("goes classic when not even one attachment link fits the rich text budget", () => {
      const headerText =
        "From: Sender <sender@example.com>\nTo: alerts@example.com\nSubject: Test Subject";
      const body = "x".repeat(32768 - 40 - headerText.length);
      const rendered = renderEmailForDelivery(
        { ...BASE, textBody: null, htmlBody: `<p>${body}</p>` },
        "html",
        "alerts@example.com",
        [{ filename: "a".repeat(40), sizeBytes: 1, url: "https://example.net/dl/a" }],
      );

      expect(rendered.richHtml).toBeUndefined();
      expect(rendered.text).toContain("/dl/a");
    });

    it("counts the attachments paragraph against the 500-block limit", () => {
      const htmlBody = "<p>x</p>".repeat(498);
      const link = [{ filename: "a.pdf", sizeBytes: 1, url: "https://example.net/dl/a" }];
      const without = renderEmailForDelivery(
        { ...BASE, textBody: null, htmlBody },
        "html",
        "alerts@example.com",
        [],
      );
      const withLink = renderEmailForDelivery(
        { ...BASE, textBody: null, htmlBody },
        "html",
        "alerts@example.com",
        link,
      );

      expect(without.richHtml).toBeDefined();
      expect(withLink.richHtml).toBeUndefined();
    });

    it("drops whole trailing attachments with a notice when the rich text budget is tight", () => {
      const links = Array.from({ length: 400 }, (_, i) => ({
        filename: `${"n".repeat(99)}${i}.bin`,
        sizeBytes: 10,
        url: `https://example.net/dl/${i}`,
      }));
      const rendered = renderEmailForDelivery(
        { ...BASE, textBody: null, htmlBody: "<p>Body</p>" },
        "html",
        "alerts@example.com",
        links,
      );

      expect(rendered.richHtml).toBeDefined();
      expect(rendered.richHtml).toMatch(/<br>\d+ attachments omitted<\/p>$/);
      expect(rendered.richHtml).not.toContain("/dl/399");
      expect(rendered.richHtml).toContain('/dl/0"');
    });

    it("keeps an unbalanced closing bracket outside a linkified URL", () => {
      const rendered = renderEmailForDelivery(
        { ...BASE, textBody: null, htmlBody: "<p>Open(https://example.com/report)</p>" },
        "html",
        "alerts@example.com",
        [],
      );

      expect(rendered.richHtml).toContain(
        '<p>Open(<a href="https://example.com/report">https://example.com/report</a>)</p>',
      );
    });

    it("renders attachment links on both transports", () => {
      const rendered = renderEmailForDelivery(
        { ...BASE, textBody: null, htmlBody: "<p>Report</p>" },
        "html",
        "alerts@example.com",
        [{ filename: "report.pdf", sizeBytes: 1, url: "https://example.com/dl/1" }],
      );

      expect(rendered.text).toContain("report.pdf");
      expect(rendered.richHtml).toContain(
        '<p>Report</p><p><b>Attachments:</b><br><a href="https://example.com/dl/1">report.pdf</a></p>',
      );
    });
  });

  describe("From header", () => {
    const encodedWord = (text: string): string =>
      `=?UTF-8?B?${Buffer.from(text, "utf8").toString("base64")}?=`;

    async function renderFrom(
      fromHeader: string,
      mode: RenderMode,
    ): Promise<ReturnType<typeof renderEmailForDelivery>> {
      const raw = Buffer.from(
        `From: ${fromHeader}\r\nTo: alerts@example.com\r\nSubject: Test Subject\r\n\r\nBody`,
      );
      const parsed = await parseEmail(raw, raw.length);
      return renderEmailForDelivery(parsed, mode, "alerts@example.com", []);
    }

    it("shows a display name without mailparser's quotes on every transport", async () => {
      const html = await renderFrom('"GitHub" <noreply@github.com>', "html");
      const plain = await renderFrom('"GitHub" <noreply@github.com>', "plaintext");

      expect(html.text).toContain("<b>From:</b> GitHub &lt;noreply@github.com&gt;\n");
      expect(html.richHtml).toContain("<b>From:</b> GitHub &lt;noreply@github.com&gt;<br>");
      expect(plain.text.startsWith("From: GitHub <noreply@github.com>\n")).toBe(true);
      expect(plain.richHtml).toContain("<b>From:</b> GitHub &lt;noreply@github.com&gt;<br>");
      for (const output of [html.text, html.richHtml, plain.text, plain.richHtml]) {
        expect(output).not.toContain('"GitHub"');
      }
    });

    it("keeps the quotes on a name that could pass for an address", async () => {
      const plain = await renderFrom('"support@paypal.com" <attacker@evil.com>', "plaintext");

      expect(plain.text.startsWith('From: "support@paypal.com" <attacker@evil.com>\n')).toBe(true);
    });

    it("shows a name-only From as the bare name", async () => {
      const plain = await renderFrom('"Just A Name"', "plaintext");

      expect(plain.text.startsWith("From: Just A Name\n")).toBe(true);
    });

    it("shows unknown when the From header is empty", async () => {
      const plain = await renderFrom("", "plaintext");

      expect(plain.text.startsWith("From: unknown\n")).toBe(true);
    });

    it("shows unknown when there is no displayable sender", () => {
      const email = { ...BASE, headerFrom: null, headerFromDisplay: null, envelopeFrom: null };

      expect(renderEmail(email, "plaintext", "alerts@example.com", [])).toMatch(/^From: unknown\n/);
    });

    it("keeps an encoded line break in the name from forging a header line", async () => {
      const from = `${encodedWord("Alice\r\nSubject: forged")} <alice@example.com>`;
      const plain = await renderFrom(from, "plaintext");
      const html = await renderFrom(from, "html");

      const plainHeader = plain.text.split("\n\n")[0] ?? "";
      expect(plainHeader.split("\n")).toEqual([
        'From: "Alice Subject: forged" <alice@example.com>',
        "To: alerts@example.com",
        "Subject: Test Subject",
      ]);
      expect(html.text).toContain(
        '<blockquote><b>From:</b> "Alice Subject: forged" &lt;alice@example.com&gt;\n<b>To:</b>',
      );
      expect(html.richHtml).toContain(
        '<blockquote><b>From:</b> "Alice Subject: forged" &lt;alice@example.com&gt;<br><b>To:</b>',
      );
      for (const output of [plain.text, html.text, html.richHtml]) {
        expect(output).not.toContain("\nSubject: forged");
        expect(output).not.toContain("\r");
      }
    });

    it("strips directional overrides from the name", async () => {
      const from = `${encodedWord("Ali\u202eecilce")} <alice@example.com>`;
      const plain = await renderFrom(from, "plaintext");
      const html = await renderFrom(from, "html");

      expect(plain.text.startsWith("From: Aliecilce <alice@example.com>\n")).toBe(true);
      for (const output of [plain.text, plain.richHtml, html.text, html.richHtml]) {
        expect(output).not.toContain("\u202e");
      }
    });
  });
});
