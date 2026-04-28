import { join } from "path";
import { randomUUID } from "crypto";
import type { FastifyInstance } from "fastify";
import { verifyWorkerRequest } from "../../utils/workerAuth.js";
import { getDb } from "../../db/client.js";
import { getApi } from "../../telegram/api.js";
import { queueInboundEmail, deliverQueuedEmail } from "../../email/pipeline.js";
import { checkInboundLimit } from "../../billing/limits.js";
import { findHostedInboundRejection } from "../../abuse/hostedInboundBlocklist.js";
import { findAliasForInbound, shouldUseHostedDomainRouting } from "../../email/inboundRouting.js";
import {
  writeRawEmail,
  writePendingRawEmailMeta,
  deletePendingRawEmailMeta,
  deleteFile,
} from "../../storage/disk.js";
import { getLogger } from "../../utils/logger.js";
import { pipelineTracker } from "../../utils/inFlight.js";
import type { AppConfig } from "../../config.js";

function rawEmailPath(rawEmailDir: string): string {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return join(rawEmailDir, date, `${randomUUID()}.eml`);
}

function shouldDeletePendingMeta(reason: string | undefined): boolean {
  return (
    reason === "duplicate" ||
    reason === "alias_not_found" ||
    reason === "sender_not_allowed" ||
    reason === "subscription_inactive" ||
    reason === "monthly_email_limit" ||
    reason === "message_size_limit" ||
    reason === "storage_limit"
  );
}

function statusForQueueRejection(reason: string | undefined): number | null {
  switch (reason) {
    case "message_size_limit":
      return 413;
    case "subscription_inactive":
    case "monthly_email_limit":
    case "storage_limit":
      return 403;
    default:
      return null;
  }
}

export function rawRoute(
  app: FastifyInstance,
  config: Pick<
    AppConfig,
    | "publicBaseUrl"
    | "attachmentDir"
    | "attachmentTtlHours"
    | "rawEmailDir"
    | "rawEmailTtlHours"
    | "maxSizeBytes"
  >,
): void {
  app.post(
    "/inbound/raw",
    {
      config: { rawBody: true, rateLimit: { max: 60, timeWindow: "1 minute" } },
      // Per-route limit overrides the global bodyLimit set in createHttpServer()
      bodyLimit: config.maxSizeBytes,
    },
    async (req, reply) => {
      const sig = req.headers["x-worker-sig"] as string | undefined;
      const ts = req.headers["x-worker-ts"] as string | undefined;
      const localPart = req.headers["x-local-part"] as string | undefined;
      // SMTP envelope sender supplied by the Cloudflare Worker (message.from = MAIL FROM).
      // Used as the authoritative sender for allow-rule enforcement.
      const envelopeFrom = req.headers["x-envelope-from"] as string | undefined;
      const recipientDomain = req.headers["x-recipient-domain"] as string | undefined;

      if (!sig || !ts) {
        await reply.status(401).send({ error: "missing signature" });
        return;
      }

      // rawBody captured by the JSON/octet-stream parsers in createHttpServer;
      // fall back to req.body directly for octet-stream in tests
      const body = req.rawBody ?? (Buffer.isBuffer(req.body) ? req.body : null);
      if (!body) {
        await reply.status(400).send({ error: "empty body" });
        return;
      }

      if (!verifyWorkerRequest(body, sig, ts)) {
        await reply.status(401).send({ error: "invalid signature" });
        return;
      }

      if (!localPart) {
        await reply.status(400).send({ error: "missing x-local-part header" });
        return;
      }

      const alias = await findAliasForInbound(getDb(), { localPart, recipientDomain });
      if (shouldUseHostedDomainRouting() && alias?.status !== "active") {
        await reply.status(403).send({ error: "rejected" });
        return;
      }
      if (alias?.status === "active") {
        const hostedBlock = await findHostedInboundRejection(getDb(), {
          organizationId: alias.organizationId,
          localPart,
          recipientDomain,
          envelopeFrom,
        });
        if (hostedBlock) {
          getLogger().info(
            {
              localPart,
              aliasId: alias.id,
              organizationId: alias.organizationId,
              blockType: hostedBlock.blockType,
              blockValue: hostedBlock.value,
            },
            "raw inbound rejected by hosted blocklist",
          );
          await reply.status(403).send({ error: "rejected" });
          return;
        }

        const inboundLimit = await checkInboundLimit(
          getDb(),
          alias.organizationId,
          body.length,
          BigInt(body.length),
        );
        if (!inboundLimit.ok) {
          const rejectionStatus = statusForQueueRejection(inboundLimit.code);
          if (rejectionStatus) {
            await reply.status(rejectionStatus).send({ error: "rejected" });
            return;
          }
        }
      }

      const storedPath = rawEmailPath(config.rawEmailDir);

      // Persist the raw email and create its delivery log before acknowledging.
      // After 202, the VPS must already have a durable record for retry/recovery.
      const rawEmailStorage = await writeRawEmail(storedPath, body);
      try {
        await writePendingRawEmailMeta(storedPath, {
          localPart,
          recipientDomain: recipientDomain ?? null,
          envelopeFrom: envelopeFrom ?? null,
          rawEmailEncryptionMode: rawEmailStorage.encryptionMode,
          rawEmailWrappedDek: rawEmailStorage.wrappedDek,
          rawEmailKekKeyId: rawEmailStorage.kekKeyId,
          correlationId: req.id,
        });
      } catch (err: unknown) {
        await deleteFile(storedPath).catch(() => {});
        throw err;
      }

      const queued = await queueInboundEmail(getDb(), {
        rawEmail: body,
        rawEmailPath: storedPath,
        localPart,
        recipientDomain,
        envelopeFrom,
        correlationId: req.id,
        rawEmailEncryption: rawEmailStorage,
        publicBaseUrl: config.publicBaseUrl,
        attachmentDir: config.attachmentDir,
        attachmentTtlHours: config.attachmentTtlHours,
        rawEmailTtlHours: config.rawEmailTtlHours,
      });

      if (queued.queued || shouldDeletePendingMeta(queued.result.reason)) {
        await deletePendingRawEmailMeta(storedPath).catch((err: unknown) => {
          getLogger().warn({ err, storedPath }, "failed to delete pending raw email metadata");
        });
      }

      if (!queued.queued) {
        const rejectionStatus = statusForQueueRejection(queued.result.reason);
        if (rejectionStatus) {
          await deleteFile(storedPath).catch((err: unknown) => {
            getLogger().warn({ err, storedPath }, "failed to delete rejected raw email");
          });
          await reply.status(rejectionStatus).send({ error: "rejected" });
          return;
        }
      }

      await reply.status(202).send({ status: "accepted" });

      if (!queued.queued) {
        return;
      }

      pipelineTracker
        .runFor(queued.job.deliveryLog.id, () => deliverQueuedEmail(getDb(), getApi(), queued.job))
        .catch((err: unknown) => {
          getLogger().error({ err, localPart }, "pipeline error");
        });
    },
  );
}
