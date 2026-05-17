import { Transform } from "node:stream";
import type { FastifyInstance, FastifyReply } from "fastify";
import { checkEgressLimit, withUserQuotaLock } from "../../billing/limits.js";
import { getDb } from "../../db/client.js";
import { findAttachmentLinkByToken, markLinkDownloaded } from "../../db/repos/attachmentLinks.js";
import {
  decrementUserUsageMonth,
  incrementUserUsageMonth,
  usageMonthForDate,
} from "../../db/repos/usage.js";
import { openAttachmentStream } from "../../storage/disk.js";
import { getLogger } from "../../utils/logger.js";
import { verifyDownloadToken } from "../../utils/tokens.js";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../../db/schema.js";

type Db = NodePgDatabase<typeof schema>;

const SAFE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/bmp",
  "image/tiff",
  "application/pdf",
]);

function isSafeMime(mime: string): boolean {
  if (SAFE_MIME_TYPES.has(mime)) return true;
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

      const now = new Date();
      if (link.expiresAt <= now || link.downloadedAt) {
        await reply.status(410).send({ error: "link expired or already used" });
        return;
      }

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
      const ownerUserId = link.attachment.userId;

      const claimResult = await withUserQuotaLock(getDb(), ownerUserId, async (tx: Db) => {
        const egressLimit = await checkEgressLimit(tx, ownerUserId, BigInt(size), quotaMonth);
        if (!egressLimit.ok) {
          return { status: "quota_exceeded" as const };
        }

        const claimed = await markLinkDownloaded(tx, link.id);
        if (!claimed) {
          return { status: "already_claimed" as const };
        }

        if (ownerUserId != null && size > 0) {
          await incrementUserUsageMonth(tx, {
            userId: ownerUserId,
            month: quotaMonth,
            egressBytes: BigInt(size),
          });
        }

        return { status: "ok" as const };
      });
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

      const safeFilename = (link.attachment.originalFilename ?? "attachment").replace(
        /["\\\r\n]/g,
        "_",
      );

      const rawMime = (link.attachment.contentType ?? "").toLowerCase().trim();
      const contentType = isSafeMime(rawMime) ? rawMime : "application/octet-stream";
      const trackedStream = trackReservedEgressUsage(
        stream,
        reply,
        ownerUserId,
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
  userId: bigint | null,
  month: string,
  egressBytes: bigint,
): NodeJS.ReadableStream {
  if (userId == null || egressBytes <= 0n) return stream;

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
    void decrementUserUsageMonth(getDb(), {
      userId,
      month,
      egressBytes: rollbackBytes,
    }).catch((err: unknown) => {
      getLogger().error(
        {
          err,
          userId: userId.toString(),
          month,
          egressBytes,
          observedBytes,
          rollbackBytes,
        },
        "failed to release reserved egress usage",
      );
    });
  });
  return stream.pipe(meter);
}
