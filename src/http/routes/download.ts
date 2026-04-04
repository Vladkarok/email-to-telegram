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

    // Check expiry and one-time use
    const now = new Date();
    if (link.expiresAt <= now || link.downloadedAt) {
      await reply.status(410).send({ error: "link expired or already used" });
      return;
    }

    // Verify HMAC token against attachment ID + expiry
    if (!verifyDownloadToken(token, link.attachmentId, link.expiresAt)) {
      await reply.status(403).send({ error: "invalid token" });
      return;
    }

    // Mark consumed before streaming
    await markLinkDownloaded(getDb(), link.id);

    const file = await readAttachmentStream(link.attachment.storagePath);
    const filename = link.attachment.originalFilename ?? "attachment";
    const contentType = link.attachment.contentType ?? "application/octet-stream";

    await reply
      .header("Content-Type", contentType)
      .header("Content-Disposition", `attachment; filename="${filename}"`)
      .header("Content-Length", file.length)
      .send(file);
  });
}
