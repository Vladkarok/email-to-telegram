import type { FastifyInstance } from "fastify";
import { verifyWorkerRequest } from "../../utils/workerAuth.js";
import { getDb } from "../../db/client.js";
import { findAliasByLocalPart } from "../../db/repos/aliases.js";
import { checkAllowRule } from "../../db/repos/allowRules.js";
import { countRecentDeliveriesByAlias } from "../../db/repos/deliveryLogs.js";
import { checkInboundLimit } from "../../billing/limits.js";
import { findHostedInboundRejection } from "../../abuse/hostedInboundBlocklist.js";
import { getLogger } from "../../utils/logger.js";

export function preflightRoute(app: FastifyInstance): void {
  app.post(
    "/inbound/preflight",
    { config: { rawBody: true, rateLimit: { max: 120, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const sig = req.headers["x-worker-sig"] as string | undefined;
      const ts = req.headers["x-worker-ts"] as string | undefined;

      if (!sig || !ts) {
        await reply.status(401).send({ error: "missing signature" });
        return;
      }

      // Use rawBody if captured by the server hook; otherwise re-serialize parsed JSON
      const body = req.rawBody ?? Buffer.from(JSON.stringify(req.body));
      if (!verifyWorkerRequest(body, sig, ts)) {
        await reply.status(401).send({ error: "invalid signature" });
        return;
      }

      const { localPart, envelopeFrom, recipientDomain } = req.body as {
        localPart: string;
        envelopeFrom?: string;
        recipientDomain?: string;
      };
      if (!localPart) {
        await reply.status(400).send({ error: "missing localPart" });
        return;
      }

      const alias = await findAliasByLocalPart(getDb(), localPart);
      if (!alias || alias.status !== "active") {
        await reply.send({ accept: false });
        return;
      }

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
          "inbound preflight rejected by hosted blocklist",
        );
        await reply.send({ accept: false });
        return;
      }

      const inboundLimit = await checkInboundLimit(getDb(), alias.organizationId);
      if (!inboundLimit.ok) {
        getLogger().info(
          {
            localPart,
            aliasId: alias.id,
            organizationId: alias.organizationId,
            reason: inboundLimit.code,
          },
          "inbound preflight rejected by hosted quota",
        );
        await reply.send({ accept: false });
        return;
      }

      // When the worker supplies the SMTP envelope sender, enforce the allow list at the edge
      // so blocked senders are rejected before raw email bytes are streamed to the VPS.
      if (envelopeFrom) {
        const allowed = await checkAllowRule(getDb(), alias.id, envelopeFrom);
        if (!allowed) {
          await reply.send({ accept: false });
          return;
        }
      }

      const recentDeliveries = await countRecentDeliveriesByAlias(
        getDb(),
        alias.id,
        new Date(Date.now() - 60 * 60 * 1000),
      );
      if (recentDeliveries >= alias.maxEmailsHour) {
        await reply.send({ accept: false });
        return;
      }

      await reply.send({ accept: true });
    },
  );
}
