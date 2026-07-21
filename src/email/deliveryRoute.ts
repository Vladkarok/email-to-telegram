/**
 * One route per delivery attempt (alias-chat-mobility contract,
 * docs/plans/2026-07-19-alias-chat-mobility.md).
 *
 * Every delivery attempt — initial (pipeline/deliver.ts) or retry
 * (retry.ts) — performs exactly ONE fresh alias read at attempt start and
 * uses the returned route tuple for ALL sends of the attempt: text,
 * photo/media chunks, the attachment fallback, reply ids, and the
 * delivery-attempt record. Never re-read the alias mid-attempt: an email's
 * text and its attachments must not split across chats, and reply ids are
 * only valid in the chat the text was sent to. A concurrent move or
 * migration takes effect from the NEXT attempt.
 */
import { findAliasById } from "../db/repos/aliases.js";
import type { EmailAddress } from "../db/schema.js";
import type { Db } from "./pipeline/types.js";

export interface DeliveryRoute {
  chatId: bigint;
  threadId: bigint | null;
}

export type AttemptRouteResult =
  | { ok: true; alias: EmailAddress; route: DeliveryRoute }
  | { ok: false; aliasStatus: string | null };

/**
 * Fresh alias read that freezes the destination for one delivery attempt.
 * Returns `ok: false` with the observed status when the alias is missing
 * or not deliverable (paused/deleted); the caller decides the lifecycle
 * consequence.
 */
export async function readAttemptRoute(db: Db, aliasId: string): Promise<AttemptRouteResult> {
  const alias = await findAliasById(db, aliasId);
  if (!alias || alias.status !== "active") {
    return { ok: false, aliasStatus: alias?.status ?? null };
  }
  return {
    ok: true,
    alias,
    route: { chatId: alias.chatId, threadId: alias.messageThreadId ?? null },
  };
}
