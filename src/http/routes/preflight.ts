import type { FastifyInstance } from "fastify";
import { verifyWorkerRequest } from "../../utils/workerAuth.js";
import { getDb } from "../../db/client.js";
import { findAliasByLocalPart } from "../../db/repos/aliases.js";

export function preflightRoute(app: FastifyInstance): void {
  app.post("/inbound/preflight", { config: { rawBody: true } }, async (req, reply) => {
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

    const { localPart } = req.body as { localPart: string };
    if (!localPart) {
      await reply.status(400).send({ error: "missing localPart" });
      return;
    }

    const alias = await findAliasByLocalPart(getDb(), localPart);
    const accept = alias !== null && alias.status === "active";

    await reply.send({ accept });
  });
}
