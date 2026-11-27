/**
 * Every src/ entry point the scenario suite uses, in one file.
 *
 * The suite also runs against older tags to show a refactor kept behaviour.
 * Everything below exists at the same path on v1.13.5 (2279feb) and on main;
 * when a path moves, a shim on the old revision changes only this file.
 */
export { createHttpServer } from "../../src/http/server.js";
export { buildRetryWorkerOptions, loadStartupConfig } from "../../src/startup/runtime.js";
export type { AppConfig } from "../../src/config.js";
export { closeDb, getDb, initDb } from "../../src/db/client.js";
export { setApi, getApi } from "../../src/telegram/api.js";
export { markBotHealthy, markBotUnhealthy } from "../../src/telegram/health.js";
export { runRetryWorker } from "../../src/email/retry.js";
export { pipelineTracker } from "../../src/utils/inFlight.js";
export { signWorkerRequest } from "../../src/utils/workerAuth.js";
export { applyPlanLimitOverrides, getPlanDefinition } from "../../src/billing/plans.js";
export {
  getActivationNoticeQueue,
  setActivationNoticeQueue,
  shutdownActivationNotices,
} from "../../src/activation/notice.js";
export { configureStorageEncryption } from "../../src/security/encryption.js";
export { setLogger } from "../../src/utils/logger.js";
