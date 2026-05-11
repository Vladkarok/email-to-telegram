import { randomUUID } from "crypto";
import { parse as parseQs } from "querystring";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { registerRoutes } from "./routes/index.js";
import { getLogger } from "../utils/logger.js";
import { recordHttpRequest } from "../observability/metrics.js";
import type { AppConfig } from "../config.js";

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
  interface FastifyContextConfig {
    rawBody?: boolean;
  }
}

function setRawBody(req: FastifyRequest, body: Buffer): void {
  req.rawBody = body;
}

export async function createHttpServer(config: AppConfig): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    bodyLimit: config.maxSizeBytes,
    // Assign each request a UUID so it can be threaded through async pipeline logs.
    genReqId: () => randomUUID(),
    // The service runs behind a Caddy reverse proxy. Without trustProxy, @fastify/rate-limit
    // keys all requests on Caddy's internal bridge IP instead of the real client address,
    // which causes everyone to share the same rate-limit bucket.
    trustProxy: true,
  });

  await app.register(helmet);
  await app.register(rateLimit, {
    global: false, // per-route limits only; apply explicitly on each route
  });

  app.addHook("onResponse", async (req, reply) => {
    recordHttpRequest({
      route: req.routeOptions.url ?? "unknown",
      method: req.method,
      statusCode: reply.statusCode,
      durationSeconds: reply.elapsedTime / 1000,
    });
  });

  // Capture raw bytes for both content types used by the Cloudflare Worker.
  // Must be done in the parser (before the body is transformed) — a preValidation
  // hook is too late because req.body is already a parsed object by then.

  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (req, body: Buffer, done) => {
    try {
      setRawBody(req, body);
      done(null, JSON.parse(body.toString("utf-8")) as Record<string, unknown>);
    } catch (err: unknown) {
      done(err instanceof Error ? err : new Error(String(err)));
    }
  });

  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer" },
    (req, body: Buffer, done) => {
      setRawBody(req, body);
      done(null, body);
    },
  );

  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "buffer" },
    (_req, body: Buffer, done) => {
      try {
        done(null, parseQs(body.toString("utf-8")));
      } catch (err: unknown) {
        done(err instanceof Error ? err : new Error(String(err)));
      }
    },
  );

  await registerRoutes(app, config);

  // Return an empty 404 for unknown routes — avoids leaking framework details.
  app.setNotFoundHandler((_req, reply) => {
    void reply.status(404).send();
  });

  return app;
}

export async function startHttpServer(
  app: FastifyInstance,
  port: number,
  host = "0.0.0.0",
): Promise<void> {
  await app.listen({ port, host });
  getLogger().info({ port, host }, "HTTP server listening");
}
