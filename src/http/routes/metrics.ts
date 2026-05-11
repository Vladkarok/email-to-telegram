import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import type { FastifyInstance } from "fastify";
import { getDb } from "../../db/client.js";
import { metricsRegistry, refreshActiveOrganizationsByPlan } from "../../observability/metrics.js";

const HMAC_CANARY = randomBytes(32);

export function metricsRoute(app: FastifyInstance, token: string): void {
  app.get(
    "/metrics",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const auth = req.headers.authorization;
      if (!auth?.startsWith("Bearer ") || !verifyToken(auth.slice("Bearer ".length), token)) {
        await reply.status(401).send("Unauthorized");
        return;
      }

      await refreshActiveOrganizationsByPlan(getDb());
      await reply.type(metricsRegistry.contentType).send(await metricsRegistry.metrics());
    },
  );
}

function verifyToken(submitted: string, expected: string): boolean {
  const a = createHmac("sha256", HMAC_CANARY).update(submitted).digest();
  const b = createHmac("sha256", HMAC_CANARY).update(expected).digest();
  return timingSafeEqual(a, b);
}
