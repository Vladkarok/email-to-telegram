import { Readable, Transform } from "node:stream";
import type { FastifyInstance, FastifyReply } from "fastify";
import { checkEgressLimit, withUserQuotaLock } from "../../../billing/limits.js";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../../../db/schema.js";

type Db = NodePgDatabase<typeof schema>;
import { getDb } from "../../../db/client.js";
import {
  type DeliveryViewLinkWithLog,
  findDeliveryViewLinkByTokenHash,
  markDeliveryViewLinkViewed,
} from "../../../db/repos/deliveryViewLinks.js";
import { listAttachmentsByDeliveryLogId } from "../../../db/repos/attachments.js";
import { createAttachmentLink } from "../../../db/repos/attachmentLinks.js";
import {
  decrementUserUsageMonth,
  incrementUserUsageMonth,
  usageMonthForDate,
} from "../../../db/repos/usage.js";
import { parseEmail } from "../../../email/parser.js";
import { readRawEmail } from "../../../storage/disk.js";
import {
  generateDownloadTokenForExpiry,
  hashStoredToken,
  verifyDeliveryViewToken,
} from "../../../utils/tokens.js";
import { getLogger } from "../../../utils/logger.js";
import { readDeliveryLogMetadata } from "../../../security/deliveryLogMetadata.js";
import {
  buildPrivacyAttachmentExpiry,
  renderEmailBodyHtml,
  renderErrorPage,
  renderPrivacyGatePage,
  renderPrivacyPage,
} from "./templates.js";

export function deliveryViewRoute(
  app: FastifyInstance,
  config: { publicBaseUrl: string; attachmentTtlHours: number; rawEmailTtlHours: number },
): void {
  app.get(
    "/view/:token",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const { token } = req.params as { token: string };
      const state = await loadAndValidateLink(token);
      if (state.status !== "ok") {
        await sendValidationError(reply, state.status);
        return;
      }

      await sendHtml(reply, 200, renderPrivacyGatePage(token));
    },
  );

  app.post(
    "/view/:token",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const { token } = req.params as { token: string };
      const state = await loadAndValidateLink(token);
      if (state.status !== "ok") {
        await sendValidationError(reply, state.status);
        return;
      }
      const { link } = state;

      if (!link.deliveryLog.rawEmailPath) {
        await sendHtml(
          reply,
          410,
          renderErrorPage(
            "Email unavailable",
            "The original email content is no longer available.",
          ),
        );
        return;
      }

      let rawEmail: Buffer;
      try {
        rawEmail = await readRawEmail(link.deliveryLog.rawEmailPath, {
          rawEmailEncryptionMode: link.deliveryLog.rawEmailEncryptionMode,
          rawEmailWrappedDek: link.deliveryLog.rawEmailWrappedDek,
          rawEmailKekKeyId: link.deliveryLog.rawEmailKekKeyId,
        });
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          await sendHtml(
            reply,
            410,
            renderErrorPage(
              "Email unavailable",
              "The original email content is no longer available.",
            ),
          );
          return;
        }

        getLogger().error({ err, deliveryLogId: link.deliveryLog.id }, "failed to read raw email");
        await sendHtml(
          reply,
          500,
          renderErrorPage("View failed", "The server could not prepare this email view."),
        );
        return;
      }

      const parsed = await parseEmail(rawEmail, rawEmail.length);
      let deliveryMetadata;
      try {
        deliveryMetadata = await readDeliveryLogMetadata({
          id: link.deliveryLog.id,
          envelopeFrom: link.deliveryLog.envelopeFrom,
          headerFrom: link.deliveryLog.headerFrom,
          subject: link.deliveryLog.subject,
          metadataCiphertext: link.deliveryLog.metadataCiphertext,
          metadataEncryptionMode:
            link.deliveryLog.metadataEncryptionMode === "local-v1" ? "local-v1" : "none",
          metadataWrappedDek: link.deliveryLog.metadataWrappedDek,
          metadataKekKeyId: link.deliveryLog.metadataKekKeyId,
          metadataEncryptedAt: link.deliveryLog.metadataEncryptedAt,
        });
      } catch (err: unknown) {
        getLogger().error(
          { err, deliveryLogId: link.deliveryLog.id },
          "failed to decrypt delivery-log metadata",
        );
        await sendHtml(
          reply,
          500,
          renderErrorPage("View failed", "The server could not prepare this email view."),
        );
        return;
      }

      const now = new Date();
      const quotaMonth = usageMonthForDate(now);
      const attachmentExpiresAt = buildPrivacyAttachmentExpiry(
        link.deliveryLog.receivedAt,
        config.attachmentTtlHours,
        config.rawEmailTtlHours,
      );
      const attachmentsStillAvailable = attachmentExpiresAt > now;
      const storedAttachments = await listAttachmentsByDeliveryLogId(getDb(), link.deliveryLog.id);
      const plannedAttachments = (attachmentsStillAvailable ? storedAttachments : []).map(
        (attachment) => {
          const { token: attachmentToken, expiresAt } = generateDownloadTokenForExpiry(
            attachment.id,
            attachmentExpiresAt,
          );
          return {
            attachmentId: attachment.id,
            token: attachmentToken,
            expiresAt,
            filename: attachment.originalFilename ?? "attachment",
            sizeBytes: attachment.sizeBytes ?? 0,
            url: `${config.publicBaseUrl}/dl/${attachmentToken}`,
          };
        },
      );

      const from = deliveryMetadata.headerFrom ?? deliveryMetadata.envelopeFrom ?? "unknown";
      const subject = deliveryMetadata.subject ?? parsed.subject ?? "(no subject)";
      const bodyHtml = renderEmailBodyHtml(parsed);
      const quotaExceededError = new Error("privacy_view_egress_limit_exceeded");
      const alreadyClaimedError = new Error("privacy_view_already_claimed");
      const ownerUserId = link.deliveryLog.userId;
      const viewResult = await withUserQuotaLock(
        getDb(),
        ownerUserId,
        async (
          tx: Db,
        ): Promise<
          | { status: "already_claimed" }
          | { status: "quota_exceeded" }
          | { status: "ok"; html: string; htmlBytes: number }
        > => {
          const activeAttachments: Array<{ filename: string; sizeBytes: number; url: string }> = [];
          for (const attachment of plannedAttachments) {
            try {
              await createAttachmentLink(
                tx,
                attachment.attachmentId,
                attachment.token,
                attachment.expiresAt,
              );
              activeAttachments.push({
                filename: attachment.filename,
                sizeBytes: attachment.sizeBytes,
                url: attachment.url,
              });
            } catch (err: unknown) {
              getLogger().warn(
                { err, attachmentId: attachment.attachmentId, deliveryLogId: link.deliveryLog.id },
                "failed to create attachment download link for privacy view",
              );
            }
          }

          const html = renderPrivacyPage({
            from,
            subject,
            receivedAt: link.deliveryLog.receivedAt,
            bodyHtml,
            attachments: activeAttachments,
          });
          const htmlBytes = Buffer.byteLength(html);
          const egressLimit = await checkEgressLimit(
            tx,
            ownerUserId,
            BigInt(htmlBytes),
            quotaMonth,
          );
          if (!egressLimit.ok) {
            throw quotaExceededError;
          }

          const claimed = await markDeliveryViewLinkViewed(tx, link.id, now);
          if (!claimed) {
            throw alreadyClaimedError;
          }

          if (ownerUserId != null && htmlBytes > 0) {
            await incrementUserUsageMonth(tx, {
              userId: ownerUserId,
              month: quotaMonth,
              egressBytes: BigInt(htmlBytes),
            });
          }

          return { status: "ok" as const, html, htmlBytes };
        },
      ).catch((err: unknown) => {
        if (err === quotaExceededError) {
          return { status: "quota_exceeded" as const };
        }
        if (err === alreadyClaimedError) {
          return { status: "already_claimed" as const };
        }
        throw err;
      });

      if (viewResult.status === "quota_exceeded") {
        await sendHtml(
          reply,
          403,
          renderErrorPage(
            "Download unavailable",
            "This account has reached its monthly email view quota.",
          ),
        );
        return;
      }
      if (viewResult.status === "already_claimed") {
        await sendHtml(
          reply,
          410,
          renderErrorPage("Link expired", "This email view link has expired or was already used."),
        );
        return;
      }

      const htmlBuffer = Buffer.from(viewResult.html, "utf8");
      const trackedStream = trackReservedEgressUsage(htmlBuffer, reply, ownerUserId, quotaMonth);
      await reply
        .status(200)
        .type("text/html; charset=utf-8")
        .header("Content-Length", htmlBuffer.length)
        .header("Cache-Control", "no-store")
        .header("Referrer-Policy", "no-referrer")
        .send(trackedStream);
    },
  );

  async function loadAndValidateLink(
    token: string,
  ): Promise<
    | { status: "ok"; link: DeliveryViewLinkWithLog }
    | { status: "not_found" | "expired" | "invalid" }
  > {
    const link = await findDeliveryViewLinkByTokenHash(getDb(), hashStoredToken(token));
    if (!link) return { status: "not_found" };

    const now = new Date();
    if (link.expiresAt <= now || link.viewedAt) return { status: "expired" };
    if (!verifyDeliveryViewToken(token, link.deliveryLogId, link.expiresAt)) {
      return { status: "invalid" };
    }
    return { status: "ok", link };
  }
}

function trackReservedEgressUsage(
  body: Buffer,
  reply: FastifyReply,
  userId: bigint | null,
  month: string,
): NodeJS.ReadableStream {
  const egressBytes = BigInt(body.length);
  if (egressBytes <= 0n) {
    return Readable.from([]);
  }
  const source = Readable.from(splitBuffer(body, 16 * 1024));
  if (userId == null) return source;

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
  source.on("error", (err: unknown) =>
    meter.destroy(err instanceof Error ? err : new Error("privacy view stream failed")),
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
  return source.pipe(meter);
}

function splitBuffer(buffer: Buffer, chunkSize: number): Buffer[] {
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < buffer.length; offset += chunkSize) {
    chunks.push(buffer.subarray(offset, Math.min(offset + chunkSize, buffer.length)));
  }
  return chunks;
}

async function sendHtml(reply: FastifyReply, statusCode: number, html: string): Promise<void> {
  await reply
    .status(statusCode)
    .type("text/html; charset=utf-8")
    .header("Cache-Control", "no-store")
    .header("Referrer-Policy", "no-referrer")
    .send(html);
}

async function sendValidationError(
  reply: FastifyReply,
  status: "not_found" | "expired" | "invalid",
): Promise<void> {
  if (status === "not_found") {
    await sendHtml(reply, 404, renderErrorPage("Link not found", "This view link does not exist."));
    return;
  }
  if (status === "invalid") {
    await sendHtml(reply, 403, renderErrorPage("Invalid link", "This email view link is invalid."));
    return;
  }
  await sendHtml(
    reply,
    410,
    renderErrorPage("Link expired", "This email view link has expired or was already used."),
  );
}
