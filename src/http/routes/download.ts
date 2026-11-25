import { Transform } from "node:stream";
import type { FastifyInstance, FastifyReply } from "fastify";
import { chargeEgress } from "../../billing/egressCharge.js";
import { getDb } from "../../db/client.js";
import {
  findAttachmentLinkByToken,
  markLinkDownloaded,
  releaseLinkDownload,
} from "../../db/repos/attachmentLinks.js";
import { decrementUserUsageMonth } from "../../db/repos/usage.js";
import { openAttachmentStream } from "../../storage/disk.js";
import { getLogger } from "../../utils/logger.js";
import { verifyDownloadToken } from "../../utils/tokens.js";

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

      // Fixes the usage month. Taken before the claim stamp, as the route has
      // always done, so a request at a month boundary keeps that month.
      const quotaAt = new Date();
      const ownerUserId = link.attachment.userId;
      const reservedSize = BigInt(link.attachment.sizeBytes ?? 0);
      const claimedAt = new Date();

      // The stored size is charged before anything is read; whatever the
      // response does not serve is given back below.
      const charge = await chargeEgress(getDb(), {
        ownerUserId,
        at: quotaAt,
        // Nothing is prepared here, so a refusal has nothing to undo and
        // commits as it did before the charge was shared with the view.
        onRefusal: "commit",
        prepare: () => Promise.resolve({ egressBytes: reservedSize, value: undefined }),
        claim: (tx) => markLinkDownloaded(tx, link.id, claimedAt),
      });
      if (charge.status === "over_limit") {
        await reply.status(403).send({ error: "download quota exceeded" });
        return;
      }
      if (charge.status === "claim_lost") {
        await reply.status(410).send({ error: "link expired or already used" });
        return;
      }
      const quotaMonth = charge.month;

      // For failures before the usage tracker below is attached to the response.
      const releaseReservedEgress = async (): Promise<void> => {
        if (ownerUserId == null || reservedSize <= 0n) return;
        await decrementUserUsageMonth(getDb(), {
          userId: ownerUserId,
          month: quotaMonth,
          egressBytes: reservedSize,
        }).catch((err: unknown) => {
          getLogger().error({ err, userId: ownerUserId.toString() }, "failed to release egress");
        });
      };

      let opened;
      try {
        opened = await openAttachmentStream(link.attachment);
      } catch {
        await releaseReservedEgress();
        // Nothing was served, so hand the one-time link back instead of
        // leaving it answering 410. Only this request's own claim is released.
        await releaseLinkDownload(getDb(), link.id, claimedAt).catch((err: unknown) => {
          getLogger().error({ err, linkId: link.id }, "failed to release download claim");
        });
        await reply.status(500).send({ error: "download failed" });
        return;
      }
      const { stream, size } = opened;

      // The response closing (sent in full, or the client gone) is the one point
      // every outcome reaches. An owned download is piped through a meter, so an
      // abort would otherwise leave the source open and, for an encrypted
      // attachment, its decrypted temp file on disk. dispose() is idempotent.
      const closeSource = (): void => {
        if (!opened.dispose) {
          stream.destroy();
          return;
        }
        void opened.dispose().catch((err: unknown) => {
          getLogger().error({ err, linkId: link.id }, "failed to dispose attachment stream");
        });
      };
      // The client may have gone while the file was being opened; "close" has
      // then already fired and would never reach a listener added now.
      if (reply.raw.destroyed) closeSource();
      else reply.raw.once("close", closeSource);

      const originalFilename = link.attachment.originalFilename ?? "attachment";
      // ASCII fallback for legacy clients: strip control chars and quote/backslash.
      const asciiFilename =
        // eslint-disable-next-line no-control-regex
        originalFilename.replace(/[\x00-\x1f\x7f"\\]/g, "_").replace(/[^\x20-\x7e]/g, "_") ||
        "attachment";
      let encodedFilename: string;
      try {
        encodedFilename = encodeURIComponent(originalFilename);
      } catch (err: unknown) {
        // A lone surrogate in the stored name. The request fails as before, but
        // the egress reserved for it is given back.
        await releaseReservedEgress();
        throw err;
      }
      const contentDisposition = `attachment; filename="${asciiFilename}"; filename*=UTF-8''${encodedFilename}`;

      const trackedStream = trackReservedEgressUsage(
        stream,
        reply,
        ownerUserId,
        quotaMonth,
        reservedSize,
      );

      await reply
        .header("Content-Type", "application/octet-stream")
        .header("Content-Disposition", contentDisposition)
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
