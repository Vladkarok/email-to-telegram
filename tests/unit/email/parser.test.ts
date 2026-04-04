import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { parseEmail } from "../../../src/email/parser.js";

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
});
