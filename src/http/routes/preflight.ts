import type { FastifyInstance } from "fastify";
import { verifyWorkerRequest } from "../../utils/workerAuth.js";
import { getDb } from "../../db/client.js";
import { getApi } from "../../telegram/api.js";
import { admitPreflight, settlePlanLimitRejection } from "../../email/inboundAdmission/index.js";
import { normalizeEnvelopeSender } from "../../email/envelopeSender.js";
import { getLogger } from "../../utils/logger.js";
import { admitPreflightNoRules } from "../../activation/notice.js";
import { recordInboundPreflight } from "../../observability/metrics.js";

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

      const verdict = await admitPreflight(getDb(), { localPart, recipientDomain, envelopeFrom });
      switch (verdict.kind) {
        case "alias_not_found":
          recordInboundPreflight("rejected", "alias_not_found");
          await reply.send({ accept: false });
          return;

        case "hosted_blocklist":
          getLogger().info(
            {
              localPart,
              aliasId: verdict.alias.id,
              userId: verdict.alias.createdBy.toString(),
              blockType: verdict.block.blockType,
              blockId: verdict.block.id,
            },
            "inbound.preflight.rejected",
          );
          recordInboundPreflight("rejected", "hosted_blocklist");
          await reply.send({ accept: false });
          return;

        case "plan_limit":
          getLogger().info(
            {
              localPart,
              aliasId: verdict.alias.id,
              userId: verdict.userId.toString(),
              reason: verdict.reason,
            },
            "inbound.preflight.rejected",
          );
          recordInboundPreflight("rejected", verdict.reason);
          // The Worker bounces on {accept:false} and never calls /inbound/raw,
          // so this is the ONLY place monthly/subscription exhaustion can
          // notify the owner. (storage_limit needs sizes and is raw-only.)
          await settlePlanLimitRejection(getDb(), getApi(), verdict);
          await reply.send({ accept: false });
          return;

        case "no_allow_rules":
          recordInboundPreflight("rejected", "sender_not_allowed");
          await reply.send({ accept: false });
          // After the response: tells the owner of a not-yet-working alias
          // that it has no allow rules. Constant-time, never throws.
          admitPreflightNoRules(verdict.alias.id);
          return;

        case "hourly_cap":
          // Defer, not bounce: the Worker turns any non-2xx into a thrown error
          // (a temporary SMTP failure), so the sender retries once the sliding
          // hour frees a slot. {accept:false} would be a permanent 550.
          getLogger().info(
            {
              localPart,
              aliasId: verdict.alias.id,
              userId: verdict.alias.createdBy.toString(),
            },
            "inbound.preflight.deferred",
          );
          recordInboundPreflight("deferred", "rate_limited");
          await reply.status(429).send({ error: "rate limited" });
          return;

        case "accepted":
          break;
      }

      recordInboundPreflight("accepted", "accepted");
      await reply.send({ accept: true });
    },
  );
}
