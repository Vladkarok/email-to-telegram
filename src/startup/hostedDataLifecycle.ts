import type { StartupOptions } from "../cli.js";
import type { AppConfig } from "../config.js";
import type { DeleteOrganizationResult } from "../dataLifecycle/deleteOrganization.js";

export function hasHostedDataLifecycleOperation(startup: StartupOptions): boolean {
  return Boolean(startup.hostedExportOrganizationId || startup.hostedDeleteOrganizationId);
}

export function assertHostedDataLifecycleAllowed(config: AppConfig): void {
  if (config.appMode !== "hosted") {
    throw new Error("Hosted data lifecycle commands require APP_MODE=hosted");
  }
}

export function hostedDeleteExitCode(result: DeleteOrganizationResult): number {
  return result.deleted && result.failedFileDeletes.length === 0 ? 0 : 1;
}
