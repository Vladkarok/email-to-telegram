import type { FastifyInstance } from "fastify";

export function healthzRoute(app: FastifyInstance): void {
  app.get("/healthz", async (_req, reply) => {
    await reply.send({ status: "ok" });
  });
}
