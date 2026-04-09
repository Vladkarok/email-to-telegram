import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  generateDeliveryViewToken,
  generateDeliveryViewTokenForExpiry,
  generateDownloadToken,
  generateDownloadTokenForExpiry,
  hashStoredToken,
  verifyDeliveryViewToken,
  verifyDownloadToken,
} from "../../../src/utils/tokens.js";

const SECRET = "test-secret-that-is-long-enough-abc";
const ATTACHMENT_ID = "uuid-attach-1234";

describe("download tokens", () => {
  let savedSecret: string | undefined;

  beforeEach(() => {
    savedSecret = process.env["HMAC_SECRET"];
    process.env["HMAC_SECRET"] = SECRET;
  });

  afterEach(() => {
    process.env["HMAC_SECRET"] = savedSecret;
  });

  it("generates a token that verifies successfully", () => {
    const { token, expiresAt } = generateDownloadToken(ATTACHMENT_ID);
    const result = verifyDownloadToken(token, ATTACHMENT_ID, expiresAt);
    expect(result).toBe(true);
  });

  it("rejects a tampered token", () => {
    const { token, expiresAt } = generateDownloadToken(ATTACHMENT_ID);
    const tampered = token.slice(0, -4) + "xxxx";
    expect(verifyDownloadToken(tampered, ATTACHMENT_ID, expiresAt)).toBe(false);
  });

  it("rejects an expired token", () => {
    const { token } = generateDownloadToken(ATTACHMENT_ID);
    const expiredAt = new Date(Date.now() - 1000); // already expired
    expect(verifyDownloadToken(token, ATTACHMENT_ID, expiredAt)).toBe(false);
  });

  it("rejects a token with wrong attachment ID", () => {
    const { token, expiresAt } = generateDownloadToken(ATTACHMENT_ID);
    expect(verifyDownloadToken(token, "different-uuid", expiresAt)).toBe(false);
  });

  it("generates unique tokens each time", () => {
    const t1 = generateDownloadToken(ATTACHMENT_ID);
    const t2 = generateDownloadToken(ATTACHMENT_ID);
    expect(t1.token).not.toBe(t2.token);
  });

  it("supports generating a token for an exact expiry", () => {
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const { token } = generateDownloadTokenForExpiry(ATTACHMENT_ID, expiresAt);
    expect(verifyDownloadToken(token, ATTACHMENT_ID, expiresAt)).toBe(true);
  });

  it("expiry is approximately TTL_HOURS in the future", () => {
    const before = Date.now();
    const { expiresAt } = generateDownloadToken(ATTACHMENT_ID, 24);
    const after = Date.now();
    const expected = before + 24 * 60 * 60 * 1000;
    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(expected - 1000);
    expect(expiresAt.getTime()).toBeLessThanOrEqual(after + 24 * 60 * 60 * 1000 + 1000);
  });

  it("rejects malformed token lengths", () => {
    expect(verifyDownloadToken("short-token", ATTACHMENT_ID, new Date(Date.now() + 60_000))).toBe(
      false,
    );
  });

  it("rejects tokens with invalid hex payloads", () => {
    const token = `${"a".repeat(32)}${"z".repeat(64)}`;
    expect(verifyDownloadToken(token, ATTACHMENT_ID, new Date(Date.now() + 60_000))).toBe(false);
  });

  it("throws when generating tokens without HMAC_SECRET", () => {
    delete process.env["HMAC_SECRET"];
    expect(() => generateDownloadToken(ATTACHMENT_ID)).toThrow(/HMAC_SECRET not set/);
  });
});

describe("delivery view tokens", () => {
  let savedSecret: string | undefined;

  beforeEach(() => {
    savedSecret = process.env["HMAC_SECRET"];
    process.env["HMAC_SECRET"] = SECRET;
  });

  afterEach(() => {
    process.env["HMAC_SECRET"] = savedSecret;
  });

  it("generates a delivery-view token that verifies successfully", () => {
    const { token, expiresAt } = generateDeliveryViewToken("log-uuid-1");
    expect(verifyDeliveryViewToken(token, "log-uuid-1", expiresAt)).toBe(true);
  });

  it("rejects a delivery-view token for the wrong delivery log", () => {
    const { token, expiresAt } = generateDeliveryViewToken("log-uuid-1");
    expect(verifyDeliveryViewToken(token, "log-uuid-2", expiresAt)).toBe(false);
  });

  it("supports generating a delivery-view token for an exact expiry", () => {
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const { token } = generateDeliveryViewTokenForExpiry("log-uuid-1", expiresAt);
    expect(verifyDeliveryViewToken(token, "log-uuid-1", expiresAt)).toBe(true);
  });

  it("hashes stored bearer tokens before persistence", () => {
    const { token } = generateDeliveryViewToken("log-uuid-1");
    expect(hashStoredToken(token)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashStoredToken(token)).toBe(hashStoredToken(token));
  });
});
