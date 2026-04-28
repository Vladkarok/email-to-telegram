import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { and, eq } from "drizzle-orm";
import { hostedInboundBlocks, type HostedInboundBlock } from "../schema.js";
import type * as schema from "../schema.js";

type Db = NodePgDatabase<typeof schema>;

export type HostedInboundBlockType =
  | "sender_email"
  | "sender_domain"
  | "recipient_domain"
  | "local_part";

export interface HostedInboundBlockInput {
  localPart?: string | null;
  recipientDomain?: string | null;
  envelopeFrom?: string | null;
}

interface Candidate {
  type: HostedInboundBlockType;
  value: string;
}

export function normalizeInboundBlockValue(value: string): string {
  return value.trim().toLowerCase();
}

export function senderDomainFromEmail(email: string): string | null {
  const normalized = normalizeInboundBlockValue(email);
  const atIndex = normalized.lastIndexOf("@");
  if (atIndex <= 0 || atIndex === normalized.length - 1) return null;
  return normalized.slice(atIndex + 1);
}

export async function findHostedInboundBlock(
  db: Db,
  input: HostedInboundBlockInput,
): Promise<HostedInboundBlock | null> {
  const candidates = buildInboundBlockCandidates(input);

  for (const candidate of candidates) {
    const [block] = await db
      .select()
      .from(hostedInboundBlocks)
      .where(
        and(
          eq(hostedInboundBlocks.blockType, candidate.type),
          eq(hostedInboundBlocks.value, candidate.value),
        ),
      )
      .limit(1);

    if (block) return block;
  }

  return null;
}

export async function createHostedInboundBlock(
  db: Db,
  input: { blockType: HostedInboundBlockType; value: string; reason?: string | null },
): Promise<void> {
  await db
    .insert(hostedInboundBlocks)
    .values({
      blockType: input.blockType,
      value: normalizeInboundBlockValue(input.value),
      reason: input.reason ?? null,
    })
    .onConflictDoNothing({
      target: [hostedInboundBlocks.blockType, hostedInboundBlocks.value],
    });
}

function buildInboundBlockCandidates(input: HostedInboundBlockInput): Candidate[] {
  const candidates: Candidate[] = [];

  addCandidate(candidates, "sender_email", input.envelopeFrom);
  if (input.envelopeFrom) {
    addCandidate(candidates, "sender_domain", senderDomainFromEmail(input.envelopeFrom));
  }
  addCandidate(candidates, "recipient_domain", input.recipientDomain);
  addCandidate(candidates, "local_part", input.localPart);

  return candidates;
}

function addCandidate(
  candidates: Candidate[],
  type: HostedInboundBlockType,
  value: string | null | undefined,
): void {
  if (!value) return;
  const normalized = normalizeInboundBlockValue(value);
  if (!normalized) return;
  candidates.push({ type, value: normalized });
}
