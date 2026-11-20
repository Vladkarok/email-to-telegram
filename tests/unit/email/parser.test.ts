import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  parseEmail,
  sanitizeAttachmentContentType,
  sanitizeAttachmentFilename,
} from "../../../src/email/parser.js";

function fixture(name: string) {
  return readFileSync(join(import.meta.dirname, "../../fixtures", name));
}

describe("parseEmail", () => {
  it("parses a simple plain-text email", async () => {
    const result = await parseEmail(fixture("simple.eml"), 500);
    expect(result.messageId).toBe("<unique-id-001@example.com>");
    expect(result.subject).toBe("Server alert - CPU high");
    expect(result.envelopeFrom).toBe("sender@example.com");
    expect(result.textBody).toContain("CPU usage has exceeded 90%");
    expect(result.htmlBody).toBeNull();
    expect(result.attachments).toHaveLength(0);
    expect(result.rawSizeBytes).toBe(500);
  });

  it("parses a multipart/alternative email", async () => {
    const buf = fixture("html-rich.eml");
    const result = await parseEmail(buf, buf.length);
    expect(result.subject).toBe("Weekly Digest");
    expect(result.textBody).toContain("plain text version");
    expect(result.htmlBody).toContain("<b>HTML</b>");
  });

  it("computes body sha256 deterministically", async () => {
    const buf = fixture("simple.eml");
    const r1 = await parseEmail(buf, buf.length);
    const r2 = await parseEmail(buf, buf.length);
    expect(r1.bodySha256).toBe(r2.bodySha256);
    expect(r1.bodySha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("handles emails without Content-Type header", async () => {
    const result = await parseEmail(fixture("no-content-type.eml"), 100);
    expect(result.subject).toBe("Legacy alert");
    expect(result.textBody).toContain("Plain text without MIME headers");
  });

  it("decodes UTF-8 encoded subject", async () => {
    const buf = fixture("unicode.eml");
    const result = await parseEmail(buf, buf.length);
    expect(result.subject).toContain("Сервер");
  });

  it("extracts envelope from from the From header", async () => {
    const result = await parseEmail(fixture("simple.eml"), 100);
    expect(result.envelopeFrom).toBe("sender@example.com");
  });

  it("keeps mailparser's From text for storage and adds an unquoted display form", async () => {
    const raw = Buffer.from(
      'From: "GitHub" <noreply@github.com>\r\nTo: alerts@example.com\r\nSubject: s\r\n\r\nBody',
    );
    const result = await parseEmail(raw, raw.length);
    expect(result.headerFrom).toBe('"GitHub" <noreply@github.com>');
    expect(result.headerFromDisplay).toBe("GitHub <noreply@github.com>");
    expect(result.headerFromEmail).toBe("noreply@github.com");
    expect(result.headerFromDomain).toBe("github.com");
  });
});

// attachments.original_filename is varchar(255), content_type varchar(127);
// Postgres counts code points and rejects NUL bytes in text.
describe("attachment metadata limits", () => {
  const codePoints = (value: string) => Array.from(value).length;
  const NUL = String.fromCharCode(0);
  const EMOJI = String.fromCodePoint(0x1f600);

  it("leaves names and types within the column limits untouched", () => {
    expect(sanitizeAttachmentFilename("report.pdf")).toBe("report.pdf");
    expect(sanitizeAttachmentFilename("")).toBe("");
    expect(sanitizeAttachmentFilename("a".repeat(251) + ".pdf")).toBe("a".repeat(251) + ".pdf");
    // 255 code points, 510 UTF-16 units: still fits the column.
    expect(sanitizeAttachmentFilename(EMOJI.repeat(255))).toBe(EMOJI.repeat(255));
    expect(sanitizeAttachmentContentType("application/pdf")).toBe("application/pdf");
    expect(sanitizeAttachmentContentType("a".repeat(127))).toBe("a".repeat(127));
  });

  it("strips NUL bytes", () => {
    expect(sanitizeAttachmentFilename(`re${NUL}port.pdf${NUL}`)).toBe("report.pdf");
    expect(sanitizeAttachmentFilename(NUL + NUL)).toBe("attachment");
    expect(sanitizeAttachmentContentType(`application/${NUL}pdf`)).toBe("application/pdf");
  });

  it("truncates a long filename to 255 characters and keeps the extension", () => {
    expect(sanitizeAttachmentFilename("a".repeat(300) + ".pdf")).toBe("a".repeat(251) + ".pdf");
    expect(sanitizeAttachmentFilename("a".repeat(300))).toBe("a".repeat(255));
  });

  it("does not keep an extension that is not one", () => {
    // Leading dot, trailing dot, or a tail too long to be an extension.
    expect(sanitizeAttachmentFilename("." + "a".repeat(300))).toBe("." + "a".repeat(254));
    expect(sanitizeAttachmentFilename("a".repeat(300) + ".")).toBe("a".repeat(255));
    expect(sanitizeAttachmentFilename("a." + "b".repeat(300))).toBe("a." + "b".repeat(253));
  });

  it("never splits a surrogate pair", () => {
    const name = sanitizeAttachmentFilename(EMOJI.repeat(300) + ".png");
    expect(name).toBe(EMOJI.repeat(251) + ".png");
    expect(codePoints(name)).toBe(255);

    const type = sanitizeAttachmentContentType("x/" + EMOJI.repeat(200));
    expect(type).toBe("x/" + EMOJI.repeat(125));
    expect(codePoints(type)).toBe(127);
  });

  it("caps a long content type at 127 characters", () => {
    expect(sanitizeAttachmentContentType("application/" + "x".repeat(200))).toBe(
      "application/" + "x".repeat(115),
    );
  });

  it("applies the limits to parsed attachments", async () => {
    const longName = "n".repeat(300) + ".txt";
    const raw = Buffer.from(
      [
        "From: sender@example.com",
        "To: alerts@example.com",
        "Subject: Long name",
        "MIME-Version: 1.0",
        'Content-Type: multipart/mixed; boundary="b1"',
        "",
        "--b1",
        "Content-Type: text/plain",
        "",
        "body",
        "--b1",
        `Content-Type: application/${"x".repeat(200)}; name="${longName}"`,
        `Content-Disposition: attachment; filename="${longName}"`,
        "Content-Transfer-Encoding: base64",
        "",
        Buffer.from("hello").toString("base64"),
        "--b1--",
        "",
      ].join("\r\n"),
    );

    const result = await parseEmail(raw, raw.length);

    expect(result.attachments).toHaveLength(1);
    const [att] = result.attachments;
    expect(att?.filename).toBe("n".repeat(251) + ".txt");
    expect(att?.contentType).toBe("application/" + "x".repeat(115));
    expect(att?.content.toString()).toBe("hello");
  });
});
