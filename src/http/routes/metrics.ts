import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import type { FastifyInstance } from "fastify";
import { getDb } from "../../db/client.js";
import { metricsRegistry, refreshBusinessGauges } from "../../observability/metrics.js";
import { getLogger } from "../../utils/logger.js";

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

      try {
        await refreshBusinessGauges(getDb());
      } catch (err) {
        getLogger().warn({ err }, "failed to refresh business gauges; serving last known values");
      }
      await reply.type(metricsRegistry.contentType).send(await metricsRegistry.metrics());
    },
  );
}

function verifyToken(submitted: string, expected: string): boolean {
  const a = createHmac("sha256", HMAC_CANARY).update(submitted).digest();
  const b = createHmac("sha256", HMAC_CANARY).update(expected).digest();
  return timingSafeEqual(a, b);
}
