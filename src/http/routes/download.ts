import { Transform } from "node:stream";
import type { FastifyInstance, FastifyReply } from "fastify";
import { checkEgressLimit, withOrganizationQuotaLock } from "../../billing/limits.js";
import { getDb } from "../../db/client.js";
import { findAttachmentLinkByToken, markLinkDownloaded } from "../../db/repos/attachmentLinks.js";
import {
  decrementOrganizationUsageMonth,
  incrementOrganizationUsageMonth,
  usageMonthForDate,
} from "../../db/repos/usage.js";
import { openAttachmentStream } from "../../storage/disk.js";
import { getLogger } from "../../utils/logger.js";
import { verifyDownloadToken } from "../../utils/tokens.js";

// SVG excluded: can execute JS when opened directly as a document despite attachment disposition.
// Text types use prefix matching (isSafeMime) to allow any stored charset variant.
const SAFE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/bmp",
  "image/tiff",
  "application/pdf",
]);

/** Return true for any MIME type safe to serve with its original charset. */
function isSafeMime(mime: string): boolean {
  if (SAFE_MIME_TYPES.has(mime)) return true;
  // Allow text/plain and text/csv with any (or no) charset parameter.
  // Do NOT rewrite the stored charset — the raw bytes may not be UTF-8.
  if (mime === "text/plain" || mime.startsWith("text/plain;")) return true;
  if (mime === "text/csv" || mime.startsWith("text/csv;")) return true;
  return false;
}

export function downloadRoute(app: FastifyInstance): void {
  app.get(
    "/dl/:token",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const { token } = req.params as { token: string };

      const link = await findAttachmentLinkByToken(getDb(), token);
      if (!link) {
        await reply.status(404).send({ error: "not found" });
        return;
      }

      // Check expiry and one-time use (fast path before hitting DB again)
      const now = new Date();
      if (link.expiresAt <= now || link.downloadedAt) {
        await reply.status(410).send({ error: "link expired or already used" });
        return;
      }

      // Verify HMAC integrity
      if (!verifyDownloadToken(token, link.attachmentId, link.expiresAt)) {
        await reply.status(403).send({ error: "invalid token" });
        return;
      }

      let opened;
      try {
        opened = await openAttachmentStream(link.attachment);
      } catch {
        await reply.status(500).send({ error: "download failed" });
        return;
      }
      const { stream, size } = opened;
      const quotaMonth = usageMonthForDate();

      const claimResult = await withOrganizationQuotaLock(
        getDb(),
        link.attachment.organizationId,
        async (tx) => {
          const egressLimit = await checkEgressLimit(
            tx,
            link.attachment.organizationId,
            BigInt(size),
            quotaMonth,
          );
          if (!egressLimit.ok) {
            return { status: "quota_exceeded" as const };
          }

          // Atomically claim the link only after the file was opened successfully.
          // This avoids burning one-time URLs on transient decryption/open failures.
          const claimed = await markLinkDownloaded(tx, link.id);
          if (!claimed) {
            return { status: "already_claimed" as const };
          }

          if (link.attachment.organizationId && size > 0) {
            await incrementOrganizationUsageMonth(tx, {
              organizationId: link.attachment.organizationId,
              month: quotaMonth,
              egressBytes: BigInt(size),
            });
          }

          return { status: "ok" as const };
        },
      );
      if (claimResult.status === "quota_exceeded") {
        await opened.dispose?.();
        await reply.status(403).send({ error: "download quota exceeded" });
        return;
      }
      if (claimResult.status === "already_claimed") {
        await opened.dispose?.();
        await reply.status(410).send({ error: "link expired or already used" });
        return;
      }

      // Strip characters that would break the quoted-string in Content-Disposition (RFC 6266)
      const safeFilename = (link.attachment.originalFilename ?? "attachment").replace(
        /["\\\r\n]/g,
        "_",
      );

      // Serve the stored MIME type if it is in the allowlist; fall back to
      // application/octet-stream for anything else.  Do not override the stored
      // charset — the raw bytes may not be UTF-8.
      const rawMime = (link.attachment.contentType ?? "").toLowerCase().trim();
      const contentType = isSafeMime(rawMime) ? rawMime : "application/octet-stream";
      const trackedStream = trackReservedEgressUsage(
        stream,
        reply,
        link.attachment.organizationId,
        quotaMonth,
        BigInt(size),
      );

      await reply
        .header("Content-Type", contentType)
        .header("Content-Disposition", `attachment; filename="${safeFilename}"`)
        .header("Content-Length", size)
        .header("Cache-Control", "no-store")
        .send(trackedStream);
    },
  );
}

function trackReservedEgressUsage(
  stream: NodeJS.ReadableStream,
  reply: FastifyReply,
  organizationId: string | null,
  month: string,
  egressBytes: bigint,
): NodeJS.ReadableStream {
  if (!organizationId || egressBytes <= 0n) return stream;

  let completed = false;
  let observedBytes = 0n;
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      observedBytes += BigInt(
        Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk)),
      );
      callback(null, chunk);
    },
  });
  stream.on("error", (err: unknown) =>
    meter.destroy(err instanceof Error ? err : new Error("attachment stream failed")),
  );
  reply.raw.once("finish", () => {
    completed = true;
  });
  reply.raw.once("close", () => {
    if (completed) return;
    const rollbackBytes = egressBytes > observedBytes ? egressBytes - observedBytes : 0n;
    if (rollbackBytes <= 0n) return;
    void decrementOrganizationUsageMonth(getDb(), {
      organizationId,
      month,
      egressBytes: rollbackBytes,
    }).catch((err: unknown) => {
      getLogger().error(
        { err, organizationId, month, egressBytes, observedBytes, rollbackBytes },
        "failed to release reserved egress usage",
      );
    });
  });
  return stream.pipe(meter);
}
