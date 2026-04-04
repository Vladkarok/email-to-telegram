import { createHmac, timingSafeEqual } from "crypto";

const MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes

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

  const ts = parseInt(timestamp, 10);
  if (isNaN(ts) || Date.now() - ts > MAX_AGE_MS) return false;

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
