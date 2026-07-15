import type { FastifyInstance } from "fastify";
import { verifyWorkerRequest } from "../../utils/workerAuth.js";
import { getDb } from "../../db/client.js";
import { checkPreflightAllowRules } from "../../db/repos/allowRules.js";
import { countRecentDeliveriesByAlias } from "../../db/repos/deliveryLogs.js";
import { checkInboundLimit } from "../../billing/limits.js";
import { isQuotaNotificationReason, notifyQuotaExhausted } from "../../billing/quotaNotifier.js";
import { incrementUserUsageMonth, usageMonthForDate } from "../../db/repos/usage.js";
import { getApi } from "../../telegram/api.js";
import { findHostedInboundRejection } from "../../abuse/hostedInboundBlocklist.js";
import { findAliasForInbound } from "../../email/inboundRouting.js";
import { normalizeEnvelopeSender } from "../../email/envelopeSender.js";
import { getLogger } from "../../utils/logger.js";
import { recordInboundPreflight, recordQuotaRejection } from "../../observability/metrics.js";

function logWorkerForwardFailed(reason: string): void {
  getLogger().warn({ route: "/inbound/preflight", reason }, "worker.forward.failed");
}

export function preflightRoute(app: FastifyInstance): void {
  app.post(
    "/inbound/preflight",
    { config: { rawBody: true, rateLimit: { max: 120, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const sig = req.headers["x-worker-sig"] as string | undefined;
      const ts = req.headers["x-worker-ts"] as string | undefined;

      if (!sig || !ts) {
        logWorkerForwardFailed("missing_signature");
        recordInboundPreflight("rejected", "missing_signature");
        await reply.status(401).send({ error: "missing signature" });
        return;
      }

      // Use rawBody if captured by the server hook; otherwise re-serialize parsed JSON
      const body = req.rawBody ?? Buffer.from(JSON.stringify(req.body));
      if (!verifyWorkerRequest(body, sig, ts)) {
        logWorkerForwardFailed("invalid_signature");
        recordInboundPreflight("rejected", "invalid_signature");
        await reply.status(401).send({ error: "invalid signature" });
        return;
      }

      const {
        localPart,
        envelopeFrom: rawEnvelopeFrom,
        recipientDomain,
      } = req.body as {
        localPart: string;
        envelopeFrom?: string;
        recipientDomain?: string;
      };
      const envelopeFrom = normalizeEnvelopeSender(rawEnvelopeFrom);
      if (!localPart) {
        logWorkerForwardFailed("missing_local_part");
        recordInboundPreflight("rejected", "missing_local_part");
        await reply.status(400).send({ error: "missing localPart" });
        return;
      }

      const alias = await findAliasForInbound(getDb(), { localPart, recipientDomain });
      if (!alias || alias.status !== "active") {
        recordInboundPreflight("rejected", "alias_not_found");
        await reply.send({ accept: false });
        return;
      }

      const hostedBlock = await findHostedInboundRejection(getDb(), {
        userId: alias.createdBy,
        localPart,
        recipientDomain,
        envelopeFrom,
      });
      if (hostedBlock) {
        getLogger().info(
          {
            localPart,
            aliasId: alias.id,
            userId: alias.createdBy.toString(),
            blockType: hostedBlock.blockType,
            blockValue: hostedBlock.value,
          },
          "inbound.preflight.rejected",
        );
        recordInboundPreflight("rejected", "hosted_blocklist");
        await reply.send({ accept: false });
        return;
      }

      // One month for the whole rejection decision (check, counter, claim).
      const month = usageMonthForDate();
      const inboundLimit = await checkInboundLimit(
        getDb(),
        alias.createdBy,
        undefined,
        undefined,
        month,
      );
      if (!inboundLimit.ok) {
        getLogger().info(
          {
            localPart,
            aliasId: alias.id,
            userId: alias.createdBy.toString(),
            reason: inboundLimit.code,
          },
          "inbound.preflight.rejected",
        );
        recordInboundPreflight("rejected", inboundLimit.code);
        recordQuotaRejection(inboundLimit.code);
        // The Worker bounces on {accept:false} and never calls /inbound/raw,
        // so this is the ONLY place monthly/subscription exhaustion can
        // notify the owner. (storage_limit needs sizes and is raw-only.)
        if (isQuotaNotificationReason(inboundLimit.code)) {
          // Charge the rejection before notifying: the while-capped reminder
          // reads rejected_count and must include this email.
          await incrementUserUsageMonth(getDb(), {
            userId: alias.createdBy,
            month,
            rejectedCount: 1,
          }).catch((err: unknown) => {
            getLogger().warn(
              { err, userId: alias.createdBy.toString() },
              "quota.rejection.count_failed",
            );
          });
          void notifyQuotaExhausted(getDb(), getApi(), alias.createdBy, inboundLimit.code, month);
        }
        await reply.send({ accept: false });
        return;
      }

      // Preflight has no raw MIME, so it cannot verify DKIM/DMARC. It only
      // rejects aliases with no allow rules; final sender authorization happens
      // in the raw pipeline.
      const allowed = await checkPreflightAllowRules(getDb(), alias.id);
      if (!allowed) {
        recordInboundPreflight("rejected", "sender_not_allowed");
        await reply.send({ accept: false });
        return;
      }

      const recentDeliveries = await countRecentDeliveriesByAlias(
        getDb(),
        alias.id,
        new Date(Date.now() - 60 * 60 * 1000),
      );
      if (recentDeliveries >= alias.maxEmailsHour) {
        recordInboundPreflight("rejected", "rate_limited");
        await reply.send({ accept: false });
        return;
      }

      recordInboundPreflight("accepted", "accepted");
      await reply.send({ accept: true });
    },
  );
}
