import type { FastifyInstance } from "fastify";
import { verifyWorkerRequest } from "../../utils/workerAuth.js";
import { getDb } from "../../db/client.js";
import { getApi } from "../../telegram/api.js";
import { processInboundEmail } from "../../email/pipeline.js";
import { getLogger } from "../../utils/logger.js";
import type { AppConfig } from "../../config.js";

export function rawRoute(
  app: FastifyInstance,
  config: Pick<AppConfig, "publicBaseUrl" | "attachmentDir" | "attachmentTtlHours">,
): void {
  app.post(
    "/inbound/raw",
    {
      config: { rawBody: true },
      bodyLimit: 26_214_400, // 25 MB
    },
    async (req, reply) => {
      const sig = req.headers["x-worker-sig"] as string | undefined;
      const ts = req.headers["x-worker-ts"] as string | undefined;
      const localPart = req.headers["x-local-part"] as string | undefined;
      // SMTP envelope sender supplied by the Cloudflare Worker (message.from = MAIL FROM).
      // Used as the authoritative sender for allow-rule enforcement.
      const envelopeFrom = req.headers["x-envelope-from"] as string | undefined;

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

      // Acknowledge immediately, process async
      await reply.status(202).send({ status: "accepted" });

      processInboundEmail(getDb(), getApi(), {
        rawEmail: body,
        localPart,
        envelopeFrom,
        publicBaseUrl: config.publicBaseUrl,
        attachmentDir: config.attachmentDir,
        attachmentTtlHours: config.attachmentTtlHours,
      }).catch((err: unknown) => {
        getLogger().error({ err, localPart }, "pipeline error");
      });
    },
  );
}
