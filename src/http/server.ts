import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import helmet from "@fastify/helmet";
import { registerRoutes } from "./routes/index.js";
import { getLogger } from "../utils/logger.js";
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

export async function createHttpServer(_config: AppConfig): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    bodyLimit: 26_214_400, // 25 MB global limit
  });

  await app.register(helmet);

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

  registerRoutes(app, _config);

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
