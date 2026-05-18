import { createHmac, timingSafeEqual } from "crypto";

export interface BillingAccessTokenPayload {
  telegramUserId: string;
  exp: number;
}

export function generateBillingAccessToken(
  payload: Omit<BillingAccessTokenPayload, "exp">,
  ttlSeconds = 10 * 60,
): string {
  const fullPayload: BillingAccessTokenPayload = {
    ...payload,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  };
  return encodeBillingAccessToken(fullPayload);
}

export function verifyBillingAccessToken(token: string): BillingAccessTokenPayload | null {
  const secret = process.env["HMAC_SECRET"];
  if (!secret) return null;

  const [encodedPayload, encodedSignature] = token.split(".");
  if (!encodedPayload || !encodedSignature) return null;

  const expectedSignature = createHmac("sha256", secret).update(encodedPayload).digest();
  let providedSignature: Buffer;
  try {
    providedSignature = Buffer.from(encodedSignature, "base64url");
  } catch {
    return null;
  }

  if (providedSignature.length !== expectedSignature.length) return null;
  if (!timingSafeEqual(providedSignature, expectedSignature)) return null;

  let payload: BillingAccessTokenPayload;
  try {
    payload = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8"),
    ) as BillingAccessTokenPayload;
  } catch {
    return null;
  }

  if (typeof payload.telegramUserId !== "string" || typeof payload.exp !== "number") {
    return null;
  }

  if (payload.exp <= Math.floor(Date.now() / 1000)) return null;
  return payload;
}

function encodeBillingAccessToken(payload: BillingAccessTokenPayload): string {
  const secret = process.env["HMAC_SECRET"];
  if (!secret) throw new Error("HMAC_SECRET not set");

  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(encodedPayload).digest("base64url");
  return `${encodedPayload}.${signature}`;
}
