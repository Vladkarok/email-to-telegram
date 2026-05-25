import { createHmac, timingSafeEqual } from "crypto";

// Worker requests must be no older than this. The window is one-sided: a
// future-dated timestamp (beyond a small skew tolerance) is rejected outright,
// which halves the replay opportunity vs. an absolute-value window.
const MAX_AGE_MS = 5 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 30 * 1000;

export interface WorkerRoutingHeaders {
  localPart: string;
  recipientDomain?: string | null;
  envelopeFrom?: string | null;
}

export function signWorkerRequest(
  body: Buffer,
  routingHeaders?: WorkerRoutingHeaders,
): { signature: string; timestamp: string; signatureVersion: "v1" | "v2" } {
  const secret = process.env["WORKER_SECRET"];
  if (!secret) throw new Error("WORKER_SECRET not set");

  const timestamp = Date.now().toString();
  const hmac = createHmac("sha256", secret);
  if (routingHeaders) {
    hmac.update(canonicalRoutingPrefix(timestamp, routingHeaders));
  } else {
    hmac.update(timestamp + ".");
  }
  const signature = hmac.update(body).digest("hex");

  return { signature, timestamp, signatureVersion: routingHeaders ? "v2" : "v1" };
}

export function verifyWorkerRequest(
  body: Buffer,
  signature: string,
  timestamp: string,
  routingHeaders?: WorkerRoutingHeaders,
): boolean {
  const secret = process.env["WORKER_SECRET"];
  if (!secret) return false;

  // Number() rejects strings with non-numeric chars (e.g. "1234abc" → NaN)
  // whereas parseInt would silently accept them.
  const ts = Number(timestamp);
  if (isNaN(ts)) return false;
  const delta = Date.now() - ts;
  if (delta > MAX_AGE_MS) return false;
  if (delta < -MAX_FUTURE_SKEW_MS) return false;

  const hmac = createHmac("sha256", secret);
  if (routingHeaders) {
    hmac.update(canonicalRoutingPrefix(timestamp, routingHeaders));
  } else {
    hmac.update(timestamp + ".");
  }
  const expected = hmac.update(body).digest("hex");

  if (signature.length !== expected.length) return false;

  try {
    return timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}

function canonicalRoutingPrefix(timestamp: string, routingHeaders: WorkerRoutingHeaders): string {
  return `${JSON.stringify([
    timestamp,
    routingHeaders.localPart,
    routingHeaders.recipientDomain ?? "",
    routingHeaders.envelopeFrom ?? "",
  ])}.`;
}
