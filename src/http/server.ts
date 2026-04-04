import Fastify, { type FastifyInstance } from "fastify";
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

export async function createHttpServer(_config: AppConfig): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    bodyLimit: 26_214_400, // 25 MB global limit
  });

  // Raw body plugin — capture raw bytes for HMAC verification
  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer" },
    (_req, body, done) => {
      done(null, body);
    },
  );

  app.addHook("preValidation", (req, _reply, done) => {
    if (req.routeOptions.config?.rawBody) {
      req.rawBody = req.body as Buffer;
    }
    done();
  });

  registerRoutes(app);

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
