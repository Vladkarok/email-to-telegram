import type { FastifyInstance } from "fastify";
import { getDb } from "../../db/client.js";
import { findAttachmentLinkByToken, markLinkDownloaded } from "../../db/repos/attachmentLinks.js";
import { readAttachmentStream } from "../../storage/disk.js";
import { verifyDownloadToken } from "../../utils/tokens.js";

export function downloadRoute(app: FastifyInstance): void {
  app.get("/dl/:token", async (req, reply) => {
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

    // Atomically claim the link — guards against concurrent requests both passing
    // the downloadedAt check above and both receiving the file
    const claimed = await markLinkDownloaded(getDb(), link.id);
    if (!claimed) {
      await reply.status(410).send({ error: "link expired or already used" });
      return;
    }

    const file = await readAttachmentStream(link.attachment.storagePath);
    // Strip characters that would break the quoted-string in Content-Disposition (RFC 6266)
    const safeFilename = (link.attachment.originalFilename ?? "attachment").replace(
      /["\\\r\n]/g,
      "_",
    );
    const contentType = link.attachment.contentType ?? "application/octet-stream";

    await reply
      .header("Content-Type", contentType)
      .header("Content-Disposition", `attachment; filename="${safeFilename}"`)
      .header("Content-Length", file.length)
      .send(file);
  });
}
