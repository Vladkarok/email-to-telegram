import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthenticateResult } from "mailauth";
import { authenticateSender } from "../../../src/email/authenticateSender.js";

const mockAuthenticate = vi.hoisted(() => vi.fn());

vi.mock("mailauth", () => ({
  authenticate: (...args: unknown[]): unknown => mockAuthenticate(...args),
}));

function rawEmail(from = "Sender <sender@example.com>"): Buffer {
  return Buffer.from(
    [
      `From: ${from}`,
      "To: inbox@example.net",
      "Subject: hello",
      "Message-ID: <auth-test@example.com>",
      "",
      "Body",
    ].join("\r\n"),
  );
}

function authResult(overrides: Partial<AuthenticateResult> = {}): AuthenticateResult {
  return {
    dkim: {
      headerFrom: ["example.com"],
      envelopeFrom: false,
      results: [],
    },
    spf: false,
    dmarc: false,
    arc: false,
    bimi: false,
    headers: "",
    ...overrides,
  } as AuthenticateResult;
}

describe("authenticateSender", () => {
  beforeEach(() => {
    mockAuthenticate.mockReset();
  });

  it("accepts an aligned DKIM pass for the RFC5322 From domain", async () => {
    mockAuthenticate.mockResolvedValue(
      authResult({
        dkim: {
          headerFrom: ["example.com"],
          envelopeFrom: false,
          results: [
            {
              signingDomain: "example.com",
              status: { result: "pass", aligned: true },
              info: "",
            },
          ],
        },
      }),
    );

    const result = await authenticateSender(rawEmail(), "bounce@mailer.example");

    expect(result.status).toBe("pass");
    expect(result.authenticatedDomains).toEqual(["example.com"]);
    const firstCall = mockAuthenticate.mock.calls[0] as
      | [
          Buffer,
          {
            sender?: string;
            disableArc?: boolean;
            disableBimi?: boolean;
            resolver?: unknown;
          },
        ]
      | undefined;
    expect(firstCall).toBeDefined();
    expect(firstCall?.[0]).toEqual(rawEmail());
    expect(firstCall?.[1]).toMatchObject({
      sender: "bounce@mailer.example",
      disableArc: true,
      disableBimi: true,
    });
    expect(typeof firstCall?.[1].resolver).toBe("function");
  });

  it("lets an aligned pass win over unrelated temporary auth errors", async () => {
    mockAuthenticate.mockResolvedValue(
      authResult({
        dkim: {
          headerFrom: ["example.com"],
          envelopeFrom: false,
          results: [
            {
              signingDomain: "example.com",
              status: { result: "pass", aligned: true },
              info: "",
            },
            {
              signingDomain: "third-party.example",
              status: { result: "temperror" },
              info: "",
            },
          ],
        },
        dmarc: {
          domain: "example.com",
          policy: "none",
          p: "none",
          sp: "none",
          status: { result: "temperror" },
          alignment: {
            spf: { result: false, strict: false },
            dkim: { result: false, strict: false },
          },
          info: "",
        },
      }),
    );

    const result = await authenticateSender(rawEmail(), "bounce@mailer.example");

    expect(result.status).toBe("pass");
    expect(result.reason).toBe("authenticated");
  });

  it("returns a temporary failure when auth lookup has no aligned pass", async () => {
    mockAuthenticate.mockResolvedValue(
      authResult({
        dkim: {
          headerFrom: ["example.com"],
          envelopeFrom: false,
          results: [
            {
              signingDomain: "example.com",
              status: { result: "temperror", aligned: true },
              info: "",
            },
          ],
        },
      }),
    );

    const result = await authenticateSender(rawEmail(), "bounce@mailer.example");

    expect(result.status).toBe("temperror");
    expect(result.reason).toBe("sender_auth_temperror");
  });

  it("rejects messages with multiple RFC5322 From identities before auth lookup", async () => {
    const result = await authenticateSender(
      rawEmail("A <a@example.com>, B <b@example.com>"),
      "bounce@mailer.example",
    );

    expect(result.status).toBe("permerror");
    expect(result.reason).toBe("header_from_multiple");
    expect(mockAuthenticate).not.toHaveBeenCalled();
  });
});
