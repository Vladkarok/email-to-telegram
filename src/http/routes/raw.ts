import { join } from "path";
import { randomUUID } from "crypto";
import type { FastifyInstance } from "fastify";
import { verifyWorkerRequest } from "../../utils/workerAuth.js";
import { getDb } from "../../db/client.js";
import { claimWorkerRequestNonce } from "../../db/repos/workerRequestNonces.js";
import { getApi } from "../../telegram/api.js";
import { deliverQueuedEmail } from "../../email/pipeline.js";
import {
  admitRawPrecheck,
  isQuotaRejection,
  queueInboundEmail,
  rejectionPolicy,
  settlePlanLimitRejection,
} from "../../email/inboundAdmission/index.js";
import {
  notifyApproachingMonthlyLimit,
  notifyQuotaExhausted,
} from "../../billing/quotaNotifier.js";
import { usageMonthForDate } from "../../db/repos/usage.js";
import { normalizeEnvelopeSender } from "../../email/envelopeSender.js";
import { admitRawSenderRejection } from "../../activation/notice.js";
import {
  writeRawEmail,
  writePendingRawEmailMeta,
  deletePendingRawEmailMeta,
  deleteFile,
} from "../../storage/disk.js";
import { getLogger } from "../../utils/logger.js";
import { pipelineTracker } from "../../utils/inFlight.js";
import type { AppConfig } from "../../config.js";
import { recordDeliveryDeferred, recordRawInbound } from "../../observability/metrics.js";

function rawEmailPath(rawEmailDir: string): string {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return join(rawEmailDir, date, `${randomUUID()}.eml`);
}

function logWorkerForwardFailed(reason: string): void {
  getLogger().warn({ route: "/inbound/raw", reason }, "worker.forward.failed");
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
    | "maxInflightDeliveries"
    | "telegramRichMessagesEnabled"
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
      const sigVersion = req.headers["x-worker-sig-v"] as string | undefined;
      const localPart = req.headers["x-local-part"] as string | undefined;
      // SMTP envelope sender supplied by the Cloudflare Worker (message.from = MAIL FROM).
      // Used as the authoritative sender for allow-rule enforcement.
      const envelopeFrom = req.headers["x-envelope-from"] as string | undefined;
      const recipientDomain = req.headers["x-recipient-domain"] as string | undefined;

      if (!sig || !ts) {
        logWorkerForwardFailed("missing_signature");
        recordRawInbound("rejected", "missing_signature");
        await reply.status(401).send({ error: "missing signature" });
        return;
      }

      // Only v2 signatures bind the routing headers into the HMAC. The legacy
      // v1 scheme (body-only) was rollout compatibility and is no longer
      // accepted: the deployed Worker always sends v2.
      if (sigVersion !== "v2") {
        logWorkerForwardFailed("unsupported_signature_version");
        recordRawInbound("rejected", "unsupported_signature_version");
        await reply.status(401).send({ error: "invalid signature" });
        return;
      }

      // rawBody captured by the JSON/octet-stream parsers in createHttpServer;
      // fall back to req.body directly for octet-stream in tests
      const body = req.rawBody ?? (Buffer.isBuffer(req.body) ? req.body : null);
      if (!body) {
        logWorkerForwardFailed("empty_body");
        recordRawInbound("rejected", "empty_body");
        await reply.status(400).send({ error: "empty body" });
        return;
      }

      const routingHeaders = { localPart: localPart ?? "", recipientDomain, envelopeFrom };
      if (!verifyWorkerRequest(body, sig, ts, routingHeaders)) {
        logWorkerForwardFailed("invalid_signature");
        recordRawInbound("rejected", "invalid_signature");
        await reply.status(401).send({ error: "invalid signature" });
        return;
      }

      const nonceClaimed = await claimWorkerRequestNonce(getDb(), sig, new Date(Number(ts)));
      if (!nonceClaimed) {
        logWorkerForwardFailed("replayed_signature");
        recordRawInbound("rejected", "replayed_signature");
        await reply.status(401).send({ error: "invalid signature" });
        return;
      }

      if (!localPart) {
        logWorkerForwardFailed("missing_local_part");
        recordRawInbound("rejected", "missing_local_part");
        await reply.status(400).send({ error: "missing x-local-part header" });
        return;
      }

      const precheck = await admitRawPrecheck(getDb(), {
        localPart,
        recipientDomain,
        envelopeFrom,
        rawSizeBytes: body.length,
      });
      switch (precheck.kind) {
        case "alias_not_found":
          recordRawInbound("rejected", "alias_not_found");
          await reply.status(403).send({ error: "rejected" });
          return;

        case "hosted_blocklist":
          getLogger().info(
            {
              localPart,
              aliasId: precheck.alias.id,
              userId: precheck.alias.createdBy.toString(),
              blockType: precheck.block.blockType,
              blockId: precheck.block.id,
            },
            "inbound.raw.rejected",
          );
          recordRawInbound("rejected", "hosted_blocklist");
          await reply.status(403).send({ error: "rejected" });
          return;

        case "plan_limit":
          recordRawInbound("rejected", precheck.reason);
          await settlePlanLimitRejection(getDb(), getApi(), precheck);
          await reply.status(precheck.status).send({ error: "rejected" });
          return;

        case "accepted":
          break;
      }
      const { alias } = precheck;

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
        telegramRichMessagesEnabled: config.telegramRichMessagesEnabled,
      });

      const rejection = queued.queued ? null : rejectionPolicy(queued.result.reason);
      const isTerminalRejection = rejection?.deleteLive ?? false;

      // For terminal rejections the email never reaches delivery_logs, so the
      // raw .eml on disk has no lifecycle owner — delete it now. Delete the
      // file *before* the pending metadata: if the process dies between the
      // two, a stale .pending.json is harmless and recoverable, whereas an
      // orphaned .eml (carrying message content) would be invisible to all
      // cleanup paths.
      if (isTerminalRejection) {
        await deleteFile(storedPath).catch((err: unknown) => {
          getLogger().warn({ err, storedPath }, "failed to delete rejected raw email");
        });
      }

      if (queued.queued || isTerminalRejection) {
        await deletePendingRawEmailMeta(storedPath).catch((err: unknown) => {
          getLogger().warn({ err, storedPath }, "failed to delete pending raw email metadata");
        });
      }

      if (!queued.queued && rejection) {
        // The policy for a missing reason is the unknown row: 202, kept.
        const reason: string = queued.result.reason ?? "unknown";
        recordRawInbound("rejected", reason);
        // A 202 rejection falls through to the accepted answer below.
        if (rejection.rawStatus !== 202) {
          if (isQuotaRejection(reason)) {
            // Prefer the owner and month resolved inside the queue
            // transaction — the route's own alias lookup may be stale, and a
            // recomputed month could straddle the UTC boundary and burn the
            // fresh month's claim.
            void notifyQuotaExhausted(
              getDb(),
              getApi(),
              queued.result.userId ?? alias.createdBy,
              reason,
              queued.result.month ?? usageMonthForDate(),
            );
          }
          await reply.status(rejection.rawStatus).send({ error: "rejected" });
          // After the response: tells the owner of a not-yet-working alias
          // why the mail bounced. Constant-time, never throws.
          if (reason === "sender_not_allowed") {
            admitRawSenderRejection({
              aliasId: queued.result.senderRejection?.aliasId ?? alias.id,
              headerFromDomain: queued.result.senderRejection?.headerFromDomain ?? null,
              envelopeFrom: normalizeEnvelopeSender(envelopeFrom),
              rawMime: body,
            });
          }
          return;
        }
      }

      if (queued.queued) {
        recordRawInbound("accepted", "accepted");
        // This accept may have pushed the user into the top band of their
        // monthly limit — warn once per month before mail starts bouncing.
        // The post-increment count from the queue transaction is authoritative:
        // re-reading usage here could miss the 80–99% band entirely during a
        // fast burst.
        const ownerId = queued.job.deliveryLog.userId ?? alias.createdBy;
        if (ownerId != null && queued.usage) {
          void notifyApproachingMonthlyLimit(
            getDb(),
            getApi(),
            ownerId,
            queued.usage.month,
            queued.usage.deliveredCount,
          );
        }
      }
      await reply.status(202).send({ status: "accepted" });

      if (!queued.queued) {
        return;
      }

      // Bound immediate post-202 delivery fan-out. Over the cap, leave the log
      // in "received" — the (sequential) retry worker drains it within minutes —
      // so an inbound flood cannot exhaust the DB pool or memory.
      if (pipelineTracker.inFlight >= config.maxInflightDeliveries) {
        recordDeliveryDeferred();
        getLogger().warn(
          {
            deliveryLogId: queued.job.deliveryLog.id,
            inFlight: pipelineTracker.inFlight,
            cap: config.maxInflightDeliveries,
          },
          "delivery deferred to retry worker: in-flight cap reached",
        );
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
