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
});
