import { createHmac } from "crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  generateBillingAccessToken,
  verifyBillingAccessToken,
} from "../../../src/billing/accessTokens.js";

describe("billing access tokens", () => {
  let savedSecret: string | undefined;

  beforeEach(() => {
    savedSecret = process.env["HMAC_SECRET"];
    process.env["HMAC_SECRET"] = "test-hmac-secret-32-chars-minimum-x";
  });

  afterEach(() => {
    process.env["HMAC_SECRET"] = savedSecret;
  });

  it("round-trips valid billing access tokens", () => {
    const token = generateBillingAccessToken({
      telegramUserId: "123",
      organizationId: "org-1",
    });

    expect(verifyBillingAccessToken(token)).toMatchObject({
      telegramUserId: "123",
      organizationId: "org-1",
    });
  });

  it("rejects expired tokens", () => {
    const token = generateBillingAccessToken(
      {
        telegramUserId: "123",
        organizationId: "org-1",
      },
      -10,
    );

    expect(verifyBillingAccessToken(token)).toBeNull();
  });

  it("rejects tampered tokens", () => {
    const token = generateBillingAccessToken({
      telegramUserId: "123",
      organizationId: "org-1",
    });

    expect(verifyBillingAccessToken(`${token}oops`)).toBeNull();
  });

  it("rejects tokens when the HMAC secret is missing", () => {
    process.env["HMAC_SECRET"] = undefined;
    expect(verifyBillingAccessToken("anything")).toBeNull();
  });

  it("rejects tokens whose payload is not valid JSON", () => {
    const encodedPayload = Buffer.from("not-json", "utf8").toString("base64url");
    const signature = createHmac("sha256", process.env["HMAC_SECRET"]!)
      .update(encodedPayload)
      .digest("base64url");

    expect(verifyBillingAccessToken(`${encodedPayload}.${signature}`)).toBeNull();
  });

  it("rejects tokens whose payload shape is invalid", () => {
    const encodedPayload = Buffer.from(
      JSON.stringify({ telegramUserId: 123, organizationId: "org-1", exp: Date.now() / 1000 + 60 }),
      "utf8",
    ).toString("base64url");
    const signature = createHmac("sha256", process.env["HMAC_SECRET"]!)
      .update(encodedPayload)
      .digest("base64url");

    expect(verifyBillingAccessToken(`${encodedPayload}.${signature}`)).toBeNull();
  });
});
