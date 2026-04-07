import { createHash } from "crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const simpleParserMock = vi.fn();

describe("parseEmail branch handling", () => {
  beforeEach(() => {
    vi.resetModules();
    simpleParserMock.mockReset();
    vi.doMock("mailparser", () => ({
      simpleParser: simpleParserMock,
    }));
  });

  afterEach(() => {
    vi.doUnmock("mailparser");
  });

  async function loadParser() {
    return import("../../../src/email/parser.js");
  }

  it("handles missing from headers and explicit html=false responses", async () => {
    simpleParserMock.mockResolvedValue({
      from: undefined,
      text: null,
      html: false,
      attachments: undefined,
      messageId: null,
      subject: null,
    });

    const { parseEmail } = await loadParser();
    const parsed = await parseEmail(Buffer.from("raw"), 3);

    expect(parsed.envelopeFrom).toBeNull();
    expect(parsed.headerFrom).toBeNull();
    expect(parsed.textBody).toBeNull();
    expect(parsed.htmlBody).toBeNull();
    expect(parsed.attachments).toEqual([]);
    expect(parsed.bodySha256).toBe(createHash("sha256").update("").digest("hex"));
  });

  it("fills attachment defaults and hashes html-only bodies", async () => {
    const attachment = Buffer.from("abc");
    simpleParserMock.mockResolvedValue({
      from: {
        value: [{ address: "sender@example.com" }],
        text: "Sender <sender@example.com>",
      },
      text: null,
      html: "<p>Hello</p>",
      attachments: [
        {
          filename: null,
          contentType: "application/octet-stream",
          size: undefined,
          content: attachment,
        },
      ],
      messageId: "<msg-1@example.com>",
      subject: "HTML only",
    });

    const { parseEmail } = await loadParser();
    const parsed = await parseEmail(Buffer.from("raw"), 3);

    expect(parsed.envelopeFrom).toBe("sender@example.com");
    expect(parsed.headerFrom).toBe("Sender <sender@example.com>");
    expect(parsed.bodySha256).toBe(createHash("sha256").update("<p>Hello</p>").digest("hex"));
    expect(parsed.attachments).toEqual([
      {
        filename: "attachment",
        contentType: "application/octet-stream",
        sizeBytes: 3,
        content: attachment,
        sha256: createHash("sha256").update(attachment).digest("hex"),
      },
    ]);
  });
});
