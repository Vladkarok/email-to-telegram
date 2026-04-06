import type { FastifyInstance } from "fastify";
import { getDb } from "../../db/client.js";
import { getLogger } from "../../utils/logger.js";
import { sql } from "drizzle-orm";

export function readyzRoute(app: FastifyInstance): void {
  app.get("/readyz", async (_req, reply) => {
    try {
      await getDb().execute(sql`SELECT 1`);
      await reply.send({ status: "ok" });
    } catch (err: unknown) {
      getLogger().error({ err }, "readyz DB check failed");
      await reply.status(503).send({ status: "error", detail: "database check failed" });
    }
  });
}
