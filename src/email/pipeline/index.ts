/**
 * Inbound email pipeline — public surface.
 *
 * Re-exports all types and stage functions so that consumers can import
 * from "./pipeline/index.js" (or the pipeline.ts shim) without knowing
 * the internal file layout.
 */
import type { Api } from "grammy";
import { queueInboundEmail } from "./queue.js";
import { deliverQueuedEmail } from "./deliver.js";
import type { Db, PipelineInput, PipelineResult } from "./types.js";

export type { Db, PipelineInput, PipelineResult, QueuedInboundEmail, QueueInboundResult } from "./types.js";
export { queueInboundEmail } from "./queue.js";
export { deliverQueuedEmail } from "./deliver.js";

/**
 * Full synchronous pipeline: queue + deliver in one call.
 * Used by the HTTP inbound route when a worker queue is not configured.
 */
export async function processInboundEmail(
  db: Db,
  api: Api | null,
  input: PipelineInput,
): Promise<PipelineResult> {
  const queued = await queueInboundEmail(db, input);
  if (!queued.queued) {
    return queued.result;
  }
  return deliverQueuedEmail(db, api, queued.job);
}
