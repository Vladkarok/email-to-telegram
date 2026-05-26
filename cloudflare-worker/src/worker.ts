/**
 * Cloudflare Email Worker — thin ingestion layer.
 *
 * For every inbound email:
 *  1. Call /inbound/preflight to verify the alias is active and the sender is allowed.
 *  2. If rejected, call message.setReject() so the sending MTA receives a 5xx bounce.
 *  3. If accepted, buffer the raw MIME bytes, sign the request, and POST to /inbound/raw.
 *
 * Authentication:
 * - preflight signs HMAC-SHA256(timestamp + "." + body_bytes, WORKER_SECRET)
 * - raw upload signs HMAC-SHA256(canonical routing headers + body_bytes, WORKER_SECRET)
 * Must match the verifyWorkerRequest() implementation on the VPS.
 */

interface Env {
  /** Shared secret between Worker and VPS, set via `wrangler secret put WORKER_SECRET`. */
  WORKER_SECRET: string;
  /** Public base URL of the VPS, e.g. https://mail.example.com */
  VPS_URL: string;
}

export default {
  async email(message: ForwardableEmailMessage, env: Env, _ctx: ExecutionContext): Promise<void> {
    const recipient = extractRecipientParts(message.to);
    if (!recipient) {
      message.setReject("550 Invalid recipient address");
      return;
    }
    const { localPart, domain: recipientDomain } = recipient;

    logSpfObservation(message.headers);

    // ── 1. Preflight — verify alias + sender before streaming raw bytes ──────
    const preflightBody = JSON.stringify({
      localPart,
      recipientDomain,
      envelopeFrom: message.from,
    });
    const preflightBytes = new TextEncoder().encode(preflightBody);

    const { signature: pfSig, timestamp: pfTs } = await sign(preflightBytes, env.WORKER_SECRET);

    let preflightResp: Response;
    try {
      preflightResp = await fetch(`${env.VPS_URL}/inbound/preflight`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Worker-Sig": pfSig,
          "X-Worker-Ts": pfTs,
        },
        body: preflightBytes,
      });
    } catch (err) {
      console.error("preflight fetch failed", err);
      throw new Error("Transient preflight failure");
    }

    if (!preflightResp.ok) {
      console.error("preflight non-2xx", preflightResp.status);
      throw new Error(`Transient preflight failure: ${preflightResp.status}`);
    }

    const { accept } = (await preflightResp.json()) as { accept: boolean };
    if (!accept) {
      message.setReject("550 Mailbox unavailable");
      return;
    }

    // ── 2. Buffer raw MIME bytes — needed to compute the body HMAC ───────────
    let rawBytes: Uint8Array;
    try {
      const arrayBuffer = await new Response(message.raw).arrayBuffer();
      rawBytes = new Uint8Array(arrayBuffer);
    } catch (err) {
      console.error("failed to read raw email", err);
      throw new Error("Transient raw email read failure");
    }

    // ── 3. POST raw bytes to VPS ──────────────────────────────────────────────
    const { signature: rawSig, timestamp: rawTs } = await sign(rawBytes, env.WORKER_SECRET, {
      localPart,
      recipientDomain,
      envelopeFrom: message.from,
    });

    let rawResp: Response;
    try {
      rawResp = await fetch(`${env.VPS_URL}/inbound/raw`, {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "X-Worker-Sig": rawSig,
          "X-Worker-Sig-V": "v2",
          "X-Worker-Ts": rawTs,
          "X-Local-Part": localPart,
          "X-Recipient-Domain": recipientDomain,
          "X-Envelope-From": message.from,
        },
        body: rawBytes,
      });
    } catch (err) {
      console.error("raw upload fetch failed", err);
      throw new Error("Transient raw upload failure");
    }

    if (!rawResp.ok) {
      const responseText = await rawResp.text();
      console.error("raw upload non-2xx", rawResp.status, responseText);
      if (isPermanentRawUploadFailure(rawResp.status)) {
        message.setReject(
          rawResp.status === 413
            ? "Message size exceeds fixed maximum message size"
            : "550 Mailbox unavailable",
        );
        return;
      }
      throw new Error(`Transient raw upload failure: ${rawResp.status}`);
    }
  },
};

/**
 * Extract the local-part and domain from a full email address.
 * Returns null if the address is malformed.
 */
function extractRecipientParts(address: string): { localPart: string; domain: string } | null {
  const atIndex = address.lastIndexOf("@");
  if (atIndex <= 0) return null;
  const local = address.slice(0, atIndex);
  const domain = address.slice(atIndex + 1).toLowerCase();
  return local.length > 0 && domain.length > 0 ? { localPart: local, domain } : null;
}

function isPermanentRawUploadFailure(status: number): boolean {
  return status === 402 || status === 403 || status === 413;
}

function logSpfObservation(headers: Headers): void {
  const authResults = headers.get("Authentication-Results") ?? "";
  if (!/\bspf=pass\b/i.test(authResults)) {
    console.warn("spf pass not observed in worker headers", {
      authenticationResultsPresent: authResults.length > 0,
    });
  }
}

/**
 * Sign a request body using HMAC-SHA256 to match the VPS verifyWorkerRequest() scheme.
 *
 * Uses the Web Crypto API available in the Cloudflare Workers runtime.
 */
async function sign(
  body: Uint8Array,
  secret: string,
  routingHeaders?: {
    localPart: string;
    recipientDomain?: string | null;
    envelopeFrom?: string | null;
  },
): Promise<{ signature: string; timestamp: string }> {
  const timestamp = Date.now().toString();
  const encoder = new TextEncoder();

  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const prefix = encoder.encode(
    routingHeaders
      ? `${JSON.stringify([
          timestamp,
          routingHeaders.localPart,
          routingHeaders.recipientDomain ?? "",
          routingHeaders.envelopeFrom ?? "",
        ])}.`
      : `${timestamp}.`,
  );
  const combined = new Uint8Array(prefix.length + body.length);
  combined.set(prefix);
  combined.set(body, prefix.length);

  const sigBuffer = await crypto.subtle.sign("HMAC", keyMaterial, combined);
  const signature = Array.from(new Uint8Array(sigBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return { signature, timestamp };
}
