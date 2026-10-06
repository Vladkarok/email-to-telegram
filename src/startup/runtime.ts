import { loadConfig, type AppConfig } from "../config.js";
import { applyPlanLimitOverrides } from "../billing/plans.js";

/**
 * Loads config and makes PLAN_LIMITS effective in the same step, so nothing
 * that runs after startup (operator commands included) can see the code
 * defaults instead of the operator's overrides.
 */
export function loadStartupConfig(): AppConfig {
  const config = loadConfig();
  applyPlanLimitOverrides(config.planLimitOverrides);
  return config;
}

export function nextPollingStartOptions(isInitialPollingStart: boolean): {
  dropPendingUpdates: boolean;
  nextIsInitialPollingStart: boolean;
} {
  return {
    dropPendingUpdates: isInitialPollingStart,
    nextIsInitialPollingStart: false,
  };
}

export function buildRetryWorkerOptions(
  config: Pick<
    AppConfig,
    | "attachmentDir"
    | "attachmentTtlHours"
    | "publicBaseUrl"
    | "rawEmailDir"
    | "rawEmailTtlHours"
    | "telegramRichMessagesEnabled"
  >,
): {
  attachmentDir: string;
  attachmentTtlHours: number;
  publicBaseUrl: string;
  rawEmailDir: string;
  rawEmailTtlHours: number;
  telegramRichMessagesEnabled: boolean;
} {
  return {
    attachmentDir: config.attachmentDir,
    attachmentTtlHours: config.attachmentTtlHours,
    publicBaseUrl: config.publicBaseUrl,
    rawEmailDir: config.rawEmailDir,
    rawEmailTtlHours: config.rawEmailTtlHours,
    telegramRichMessagesEnabled: config.telegramRichMessagesEnabled,
  };
}
