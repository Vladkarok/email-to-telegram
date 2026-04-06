import type { FastifyInstance } from "fastify";

export function healthzRoute(app: FastifyInstance): void {
  app.get(
    "/healthz",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (_req, reply) => {
      await reply.send({ status: "ok" });
    },
  );
}
