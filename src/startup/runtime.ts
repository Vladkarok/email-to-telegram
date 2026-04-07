import type { AppConfig } from "../config.js";

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
    "attachmentDir" | "attachmentTtlHours" | "publicBaseUrl" | "rawEmailDir" | "rawEmailTtlHours"
  >,
): {
  attachmentDir: string;
  attachmentTtlHours: number;
  publicBaseUrl: string;
  rawEmailDir: string;
  rawEmailTtlHours: number;
} {
  return {
    attachmentDir: config.attachmentDir,
    attachmentTtlHours: config.attachmentTtlHours,
    publicBaseUrl: config.publicBaseUrl,
    rawEmailDir: config.rawEmailDir,
    rawEmailTtlHours: config.rawEmailTtlHours,
  };
}
