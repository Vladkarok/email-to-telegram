import type { FastifyInstance } from "fastify";
import { isBotHealthy } from "../../telegram/health.js";

export function healthzRoute(app: FastifyInstance): void {
  app.get(
    "/healthz",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (_req, reply) => {
      if (!isBotHealthy()) {
        await reply.status(503).send({ status: "degraded" });
        return;
      }
      await reply.send({ status: "ok" });
    },
  );
}
