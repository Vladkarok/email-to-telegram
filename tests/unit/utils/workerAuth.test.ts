import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHmac } from "crypto";
import { signWorkerRequest, verifyWorkerRequest } from "../../../src/utils/workerAuth.js";

const SECRET = "worker-secret-test-32chars-abcdef";

describe("workerAuth", () => {
  let savedSecret: string | undefined;

  beforeEach(() => {
    savedSecret = process.env["WORKER_SECRET"];
    process.env["WORKER_SECRET"] = SECRET;
  });

  afterEach(() => {
    process.env["WORKER_SECRET"] = savedSecret;
  });

  it("signed request verifies successfully", () => {
    const body = Buffer.from("raw email content");
    const { signature, timestamp } = signWorkerRequest(body);
    expect(verifyWorkerRequest(body, signature, timestamp)).toBe(true);
  });

  it("signed v2 request verifies with routing headers", () => {
    const body = Buffer.from("raw email content");
    const routing = {
      localPart: "alerts",
      recipientDomain: "example.com",
      envelopeFrom: "sender@example.net",
    };
    const { signature, timestamp, signatureVersion } = signWorkerRequest(body, routing);
    expect(signatureVersion).toBe("v2");
    expect(verifyWorkerRequest(body, signature, timestamp, routing)).toBe(true);
  });

  it("rejects v2 request when routing headers are changed", () => {
    const body = Buffer.from("raw email content");
    const { signature, timestamp } = signWorkerRequest(body, {
      localPart: "alerts",
      recipientDomain: "example.com",
      envelopeFrom: "sender@example.net",
    });
    expect(
      verifyWorkerRequest(body, signature, timestamp, {
        localPart: "billing",
        recipientDomain: "example.com",
        envelopeFrom: "sender@example.net",
      }),
    ).toBe(false);
  });

  it("rejects a tampered body", () => {
    const body = Buffer.from("raw email content");
    const { signature, timestamp } = signWorkerRequest(body);
    const tampered = Buffer.from("tampered content");
    expect(verifyWorkerRequest(tampered, signature, timestamp)).toBe(false);
  });

  it("rejects a tampered signature", () => {
    const body = Buffer.from("raw email content");
    const { signature, timestamp } = signWorkerRequest(body);
    const badSig = signature.slice(0, -4) + "0000";
    expect(verifyWorkerRequest(body, badSig, timestamp)).toBe(false);
  });

  it("rejects a request older than 5 minutes", () => {
    const body = Buffer.from("raw email content");
    const oldTimestamp = (Date.now() - 6 * 60 * 1000).toString();
    const staleSignature = createHmac("sha256", SECRET)
      .update(oldTimestamp + ".")
      .update(body)
      .digest("hex");
    expect(verifyWorkerRequest(body, staleSignature, oldTimestamp)).toBe(false);
  });

  it("rejects when WORKER_SECRET is not set", () => {
    delete process.env["WORKER_SECRET"];
    const body = Buffer.from("data");
    expect(verifyWorkerRequest(body, "anysig", Date.now().toString())).toBe(false);
  });

  it("throws when signing without WORKER_SECRET", () => {
    delete process.env["WORKER_SECRET"];
    expect(() => signWorkerRequest(Buffer.from("data"))).toThrow(/WORKER_SECRET not set/);
  });

  it("rejects a request whose timestamp is more than 30s in the future", () => {
    const body = Buffer.from("raw email content");
    const futureTimestamp = (Date.now() + 60 * 1000).toString();
    const futureSig = createHmac("sha256", SECRET)
      .update(futureTimestamp + ".")
      .update(body)
      .digest("hex");
    expect(verifyWorkerRequest(body, futureSig, futureTimestamp)).toBe(false);
  });

  it("accepts a slight future-skew within the tolerance", () => {
    const body = Buffer.from("raw email content");
    const skewedTimestamp = (Date.now() + 5 * 1000).toString();
    const skewedSig = createHmac("sha256", SECRET)
      .update(skewedTimestamp + ".")
      .update(body)
      .digest("hex");
    expect(verifyWorkerRequest(body, skewedSig, skewedTimestamp)).toBe(true);
  });

  it("rejects a request with a non-numeric timestamp", () => {
    const body = Buffer.from("raw email content");
    const { signature } = signWorkerRequest(body);
    expect(verifyWorkerRequest(body, signature, "123abc")).toBe(false);
  });

  it("rejects a request when the signature length is wrong", () => {
    const body = Buffer.from("raw email content");
    const { timestamp } = signWorkerRequest(body);
    expect(verifyWorkerRequest(body, "abcd", timestamp)).toBe(false);
  });
});
