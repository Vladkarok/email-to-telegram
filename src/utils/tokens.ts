import { createHmac, randomBytes, timingSafeEqual } from "crypto";

const NONCE_HEX_LEN = 32; // 16 bytes as hex

export function generateDownloadToken(
  attachmentId: string,
  ttlHours = 24,
): { token: string; expiresAt: Date } {
  const secret = process.env["HMAC_SECRET"];
  if (!secret) throw new Error("HMAC_SECRET not set");

  const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);
  const expiresAtUnix = Math.floor(expiresAt.getTime() / 1000).toString();
  const nonce = randomBytes(16).toString("hex");

  const hmac = createHmac("sha256", secret)
    .update(`${attachmentId}:${expiresAtUnix}:${nonce}`)
    .digest("hex");

  return { token: `${nonce}${hmac}`, expiresAt };
}

export function verifyDownloadToken(token: string, attachmentId: string, expiresAt: Date): boolean {
  if (expiresAt <= new Date()) return false;

  const secret = process.env["HMAC_SECRET"];
  if (!secret) return false;

  if (token.length !== NONCE_HEX_LEN + 64) return false;

  const nonce = token.slice(0, NONCE_HEX_LEN);
  const providedHmac = token.slice(NONCE_HEX_LEN);

  const expiresAtUnix = Math.floor(expiresAt.getTime() / 1000).toString();
  const expectedHmac = createHmac("sha256", secret)
    .update(`${attachmentId}:${expiresAtUnix}:${nonce}`)
    .digest("hex");

  try {
    return timingSafeEqual(Buffer.from(providedHmac, "hex"), Buffer.from(expectedHmac, "hex"));
  } catch {
    return false;
  }
}
