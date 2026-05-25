import type { FastifyInstance } from "fastify";
import { verifyWorkerRequest } from "../../utils/workerAuth.js";
import { getDb } from "../../db/client.js";
import { checkAllowRule } from "../../db/repos/allowRules.js";
import { countRecentDeliveriesByAlias } from "../../db/repos/deliveryLogs.js";
import { checkInboundLimit } from "../../billing/limits.js";
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

      const inboundLimit = await checkInboundLimit(getDb(), alias.createdBy);
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
        await reply.send({ accept: false });
        return;
      }

      // The allow list is an authorization check. If the trusted SMTP envelope
      // sender is missing (for example MAIL FROM:<>), fail closed instead of
      // falling through or trusting MIME From: later in the pipeline.
      if (!envelopeFrom) {
        recordInboundPreflight("rejected", "sender_missing");
        await reply.send({ accept: false });
        return;
      }
      const allowed = await checkAllowRule(getDb(), alias.id, envelopeFrom);
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
