import type { FastifyInstance } from "fastify";
import { healthzRoute } from "./healthz.js";
import { readyzRoute } from "./readyz.js";
import { preflightRoute } from "./preflight.js";
import { rawRoute } from "./raw.js";
import { downloadRoute } from "./download.js";

export function registerRoutes(app: FastifyInstance): void {
  healthzRoute(app);
  readyzRoute(app);
  preflightRoute(app);
  rawRoute(app);
  downloadRoute(app);
}
