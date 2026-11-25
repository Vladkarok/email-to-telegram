import { loadConfig } from "./config.js";

/**
 * Whether hosted-only behaviour applies: plan limits, hosted domain routing,
 * the inbound blocklist, alias-creation throttling and the impersonation guard.
 *
 * An explicit APP_MODE wins, so a mode can be forced without a full valid
 * config. Otherwise the loaded config decides, and a config that fails to load
 * counts as self-hosted instead of throwing. Callers that must fail on an
 * invalid config read `loadConfig().appMode` directly instead of using this.
 */
export function isHostedMode(): boolean {
  const appMode = process.env["APP_MODE"];
  if (appMode === "hosted") return true;
  if (appMode === "self-hosted") return false;

  try {
    return loadConfig().appMode === "hosted";
  } catch {
    return false;
  }
}
