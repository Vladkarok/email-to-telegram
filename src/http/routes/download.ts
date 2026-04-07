import type { FastifyInstance } from "fastify";
import { getDb } from "../../db/client.js";
import { findAttachmentLinkByToken, markLinkDownloaded } from "../../db/repos/attachmentLinks.js";
import { openAttachmentStream } from "../../storage/disk.js";
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

      // Atomically claim the link — guards against concurrent requests both passing
      // the downloadedAt check above and both receiving the file
      const claimed = await markLinkDownloaded(getDb(), link.id);
      if (!claimed) {
        await reply.status(410).send({ error: "link expired or already used" });
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

      await reply
        .header("Content-Type", contentType)
        .header("Content-Disposition", `attachment; filename="${safeFilename}"`)
        .header("Content-Length", size)
        .header("Cache-Control", "no-store")
        .send(stream);
    },
  );
}
