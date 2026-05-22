import { createHmac, timingSafeEqual } from "crypto";

// Worker requests must be no older than this. The window is one-sided: a
// future-dated timestamp (beyond a small skew tolerance) is rejected outright,
// which halves the replay opportunity vs. an absolute-value window.
const MAX_AGE_MS = 5 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 30 * 1000;

export function signWorkerRequest(body: Buffer): { signature: string; timestamp: string } {
  const secret = process.env["WORKER_SECRET"];
  if (!secret) throw new Error("WORKER_SECRET not set");

  const timestamp = Date.now().toString();
  const signature = createHmac("sha256", secret)
    .update(timestamp + ".")
    .update(body)
    .digest("hex");

  return { signature, timestamp };
}

export function verifyWorkerRequest(body: Buffer, signature: string, timestamp: string): boolean {
  const secret = process.env["WORKER_SECRET"];
  if (!secret) return false;

  // Number() rejects strings with non-numeric chars (e.g. "1234abc" → NaN)
  // whereas parseInt would silently accept them.
  const ts = Number(timestamp);
  if (isNaN(ts)) return false;
  const delta = Date.now() - ts;
  if (delta > MAX_AGE_MS) return false;
  if (delta < -MAX_FUTURE_SKEW_MS) return false;

  const expected = createHmac("sha256", secret)
    .update(timestamp + ".")
    .update(body)
    .digest("hex");

  if (signature.length !== expected.length) return false;

  try {
    return timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}
