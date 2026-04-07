import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../../config.js";
import { healthzRoute } from "./healthz.js";
import { readyzRoute } from "./readyz.js";
import { preflightRoute } from "./preflight.js";
import { rawRoute } from "./raw.js";
import { downloadRoute } from "./download.js";
import { deliveryViewRoute } from "./view.js";

export function registerRoutes(
  app: FastifyInstance,
  config: Pick<
    AppConfig,
    | "publicBaseUrl"
    | "attachmentDir"
    | "attachmentTtlHours"
    | "rawEmailDir"
    | "rawEmailTtlHours"
    | "maxSizeBytes"
  >,
): void {
  healthzRoute(app);
  readyzRoute(app);
  preflightRoute(app);
  rawRoute(app, config);
  downloadRoute(app);
  deliveryViewRoute(app, config);
}
