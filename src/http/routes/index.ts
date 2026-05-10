import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../../config.js";
import { healthzRoute } from "./healthz.js";
import { readyzRoute } from "./readyz.js";
import { preflightRoute } from "./preflight.js";
import { rawRoute } from "./raw.js";
import { downloadRoute } from "./download.js";
import { deliveryViewRoute } from "./view.js";
import { billingRoutes } from "./billing.js";
import { adminRoutes } from "./admin/index.js";

export type RouteConfig = Pick<
  AppConfig,
  | "publicBaseUrl"
  | "attachmentDir"
  | "attachmentTtlHours"
  | "rawEmailDir"
  | "rawEmailTtlHours"
  | "maxSizeBytes"
  | "adminEnabled"
  | "adminSecret"
  | "adminSessionSecret"
  | "adminSessionTtlMinutes"
>;

export async function registerRoutes(app: FastifyInstance, config: RouteConfig): Promise<void> {
  healthzRoute(app);
  readyzRoute(app);
  preflightRoute(app);
  rawRoute(app, config);
  downloadRoute(app);
  deliveryViewRoute(app, config);
  billingRoutes(app);

  if (config.adminEnabled && config.adminSecret) {
    await app.register(async (instance) => {
      await adminRoutes(instance, config);
    });
  }
}
